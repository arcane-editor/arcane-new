//! Lifetime ownership for command-tool children, including cancellation.
//! Windows starts the shell suspended so it cannot spawn outside its job.

#[cfg(unix)]
pub struct ProcessTree(i32);
#[cfg(unix)]
impl ProcessTree {
    pub fn prepare(command: &mut tokio::process::Command) {
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    pub fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        child
            .id()
            .map(|id| Self(id as i32))
            .ok_or_else(|| std::io::Error::other("command already exited"))
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            libc::killpg(self.0, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub struct ProcessTree {
        _job: OwnedHandle,
    }
    fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }
    impl ProcessTree {
        pub fn prepare(command: &mut tokio::process::Command) {
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        pub fn attach(child: &tokio::process::Child) -> io::Result<Self> {
            // All handles have one owner; dropping the guard on timeout, future
            // cancellation or normal completion terminates surviving descendants.
            unsafe {
                let job = own(CreateJobObjectW(std::ptr::null(), std::ptr::null()))?;
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let process = child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("command already exited"))?;
                if AssignProcessToJobObject(job.as_raw_handle(), process) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let tree = Self { _job: job };
                let pid = child
                    .id()
                    .ok_or_else(|| io::Error::other("command already exited"))?;
                // std/tokio expose the process handle but not its initial thread.
                // A suspended process has not executed user code; locate that
                // thread with the documented ToolHelp API, then resume it.
                let snapshot = own(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0))?;
                let mut entry: THREADENTRY32 = zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry);
                while found != 0 {
                    if entry.th32OwnerProcessID == pid {
                        let thread = own(OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID))?;
                        if ResumeThread(thread.as_raw_handle()) == u32::MAX {
                            return Err(io::Error::last_os_error());
                        }
                        return Ok(tree);
                    }
                    found = Thread32Next(snapshot.as_raw_handle(), &mut entry);
                }
                Err(io::Error::other(
                    "could not locate suspended command thread",
                ))
            }
        }
    }
}
#[cfg(windows)]
pub use windows::ProcessTree;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancellation_terminates_child_and_grandchild() {
        assert_tree_stops(false).await;
    }

    #[tokio::test]
    async fn execute_command_timeout_terminates_child_and_grandchild() {
        assert_tree_stops(true).await;
    }

    async fn assert_tree_stops(timed_out: bool) {
        let dir = tempfile::tempdir().unwrap();
        let heartbeat = dir.path().join("heartbeat.txt");
        let script = dir.path().join("child.ps1");
        let grandchild = dir.path().join("grandchild.ps1");
        let quoted = |path: &std::path::Path| path.to_string_lossy().replace('\'', "''");
        std::fs::write(&grandchild, format!("while ($true) {{ Add-Content -LiteralPath '{}' -Value 'alive'; Start-Sleep -Milliseconds 40 }}", quoted(&heartbeat))).unwrap();
        std::fs::write(&script, format!("$PID | Set-Content -Encoding ascii -LiteralPath '{}'; $p = Start-Process powershell.exe -NoNewWindow -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"{}\"' -PassThru; $p.Id | Set-Content -Encoding ascii -LiteralPath '{}'; while ($true) {{ Start-Sleep -Milliseconds 100 }}", quoted(&dir.path().join("leader.pid")), quoted(&grandchild), quoted(&dir.path().join("grandchild.pid")))).unwrap();
        let running = if timed_out {
            let command = format!(
                "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
                script.display()
            );
            let cwd = dir.path().to_string_lossy().into_owned();
            tokio::spawn(async move {
                crate::execute_command(command, cwd, Some(10_000))
                    .await
                    .map(|_| ())
            })
        } else {
            let mut command = crate::process_util::async_command("powershell.exe");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            ProcessTree::prepare(&mut command);
            let mut child = command.spawn().unwrap();
            let tree = ProcessTree::attach(&child).unwrap();
            tokio::spawn(async move {
                let _tree = tree;
                child.wait().await.map(|_| ()).map_err(|e| e.to_string())
            })
        };
        tokio::time::timeout(Duration::from_secs(15), async {
            while !heartbeat.exists() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("grandchild must actually run before testing cancellation");
        let pid_from = |name: &str| -> u32 {
            std::fs::read_to_string(dir.path().join(name))
                .unwrap()
                .trim_start_matches('\u{feff}')
                .trim()
                .parse()
                .unwrap()
        };
        let leader = pid_from("leader.pid");
        let grandchild_pid = pid_from("grandchild.pid");
        if timed_out {
            assert!(running.await.unwrap().unwrap_err().contains("timed out"));
        } else {
            running.abort();
            let _ = running.await;
        }
        for pid in [leader, grandchild_pid] {
            use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
            use windows_sys::Win32::System::Threading::{
                OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
            };
            unsafe {
                let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
                if !handle.is_null() {
                    let exited = WaitForSingleObject(handle, 5000);
                    CloseHandle(handle);
                    assert_eq!(exited, WAIT_OBJECT_0, "PID {pid} survived cancellation");
                }
            }
        }
        let size = std::fs::metadata(&heartbeat).unwrap().len();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(std::fs::metadata(heartbeat).unwrap().len(), size);
    }
}
