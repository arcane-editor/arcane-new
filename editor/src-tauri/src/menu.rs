// macOS native menu bar.
// Items emit Tauri events; the JS side listens and dispatches the
// matching command via the existing command registry.

use tauri::{
    menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Wry,
};

#[cfg(target_os = "macos")]
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_handle = app.clone();
    let pkg_info = app_handle.package_info();
    let about = PredefinedMenuItem::about(
        &app_handle,
        Some("About Arcane"),
        Some(AboutMetadata {
            name: Some(pkg_info.name.clone()),
            version: Some(pkg_info.version.to_string()),
            ..Default::default()
        }),
    )?;

    // App menu
    let app_submenu = SubmenuBuilder::new(&app_handle, &pkg_info.name)
        .item(&about)
        .separator()
        .item(&PredefinedMenuItem::services(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(&app_handle, None)?)
        .item(&PredefinedMenuItem::hide_others(&app_handle, None)?)
        .item(&PredefinedMenuItem::show_all(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(&app_handle, None)?)
        .build()?;

    // File menu
    let new_file = MenuItemBuilder::with_id("file.new", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(&app_handle)?;
    let new_window = MenuItemBuilder::with_id("file.newWindow", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(&app_handle)?;
    let open_folder = MenuItemBuilder::with_id("file.openFolder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(&app_handle)?;
    let open_recent = MenuItemBuilder::with_id("file.openRecent", "Open Recent…")
        .build(&app_handle)?;
    let save_file = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(&app_handle)?;
    let close_tab = MenuItemBuilder::with_id("file.closeTab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(&app_handle)?;
    let close_all_tabs = MenuItemBuilder::with_id("tab.closeAll", "Close All Tabs")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(&app_handle)?;
    // CmdOrCtrl+Shift+T belongs to this command in the JS registry
    // (`tab.reopenClosed` in App.tsx). The native menu used to give the chord
    // to the theme picker, and on macOS the native menu wins — so the same
    // chord reopened a closed tab on Windows and opened the theme picker on
    // macOS. `keybinding-parity.test.ts` now fails on any such divergence.
    let reopen_closed_tab = MenuItemBuilder::with_id("tab.reopenClosed", "Reopen Closed Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(&app_handle)?;
    let file_submenu = SubmenuBuilder::new(&app_handle, "File")
        .item(&new_file)
        .item(&new_window)
        .separator()
        .item(&open_folder)
        .item(&open_recent)
        .separator()
        .item(&save_file)
        .separator()
        .item(&close_tab)
        .item(&close_all_tabs)
        .item(&reopen_closed_tab)
        .build()?;

    // Edit menu
    let edit_submenu = SubmenuBuilder::new(&app_handle, "Edit")
        .item(&PredefinedMenuItem::undo(&app_handle, None)?)
        .item(&PredefinedMenuItem::redo(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(&app_handle, None)?)
        .item(&PredefinedMenuItem::copy(&app_handle, None)?)
        .item(&PredefinedMenuItem::paste(&app_handle, None)?)
        .item(&PredefinedMenuItem::select_all(&app_handle, None)?)
        .build()?;

    // View menu
    let toggle_left = MenuItemBuilder::with_id("view.toggleSidebar", "Toggle Left Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(&app_handle)?;
    let toggle_right = MenuItemBuilder::with_id("view.toggleRightSidebar", "Toggle Right Sidebar")
        .accelerator("CmdOrCtrl+K")
        .build(&app_handle)?;
    // id/label/accelerator must track `terminal.toggle`, not
    // `view.toggleBottomPanel`: this branch moved `mod+j` to the command that
    // spawns the first terminal and left `view.toggleBottomPanel` unbound in
    // the JS command registry (App.tsx) so exactly one command owns the
    // chord. But the native menu's accelerator is registered with the OS
    // independently of that registry — `handle_menu_event` below just emits
    // this item's id and the frontend calls `executeCommand(id)` on it
    // directly, bypassing the keybinding lookup entirely. Leaving the id as
    // `view.toggleBottomPanel` would let macOS's menu keep answering Cmd+J
    // with the plain visibility flip, and — since `mod+`` ` was also removed
    // — `terminal.toggle` would have no keyboard chord at all on macOS.
    let toggle_terminal = MenuItemBuilder::with_id("terminal.toggle", "Toggle Terminal")
        .accelerator("CmdOrCtrl+J")
        .build(&app_handle)?;
    let cmd_palette = MenuItemBuilder::with_id("palette.commands", "Command Palette")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(&app_handle)?;
    let quick_open = MenuItemBuilder::with_id("palette.quickOpen", "Quick Open File…")
        .accelerator("CmdOrCtrl+P")
        .build(&app_handle)?;
    // No accelerator: CmdOrCtrl+Shift+T is Reopen Closed Tab (see the File
    // menu). The theme picker stays reachable from this menu and the command
    // palette, which is enough for something used once a month.
    let theme_picker = MenuItemBuilder::with_id("theme.openPicker", "Color Theme…")
        .build(&app_handle)?;
    let view_submenu = SubmenuBuilder::new(&app_handle, "View")
        .item(&cmd_palette)
        .item(&quick_open)
        .separator()
        .item(&toggle_left)
        .item(&toggle_right)
        .item(&toggle_terminal)
        .separator()
        .item(&theme_picker)
        .item(&PredefinedMenuItem::fullscreen(&app_handle, None)?)
        .build()?;

    // Window menu
    let window_submenu = SubmenuBuilder::new(&app_handle, "Window")
        .item(&PredefinedMenuItem::minimize(&app_handle, None)?)
        .item(&PredefinedMenuItem::maximize(&app_handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(&app_handle, None)?)
        .build()?;

    let menu = MenuBuilder::new(&app_handle)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()?;

    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    let focused = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false));
    match focused {
        Some((label, _)) => {
            let _ = app.emit_to(label.as_str(), "menu-action", event_id.to_string());
        }
        None => {
            let _ = app.emit("menu-action", event_id.to_string());
        }
    }
}
