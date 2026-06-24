use serde::{Deserialize, Serialize};
use std::fs;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub results: Vec<FileSearchResult>,
    pub total_matches: usize,
    pub file_count: usize,
    pub truncated: bool,
}

#[tauri::command]
pub fn search_in_files(
    workspace_path: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include_pattern: Option<String>,
    exclude_pattern: Option<String>,
    file_extensions: Option<Vec<String>>,
) -> Result<SearchResults, String> {
    let skip_dirs: &[&str] = &["node_modules", "target", ".git", "dist", "build", ".next", ".nuxt"];
    let max_matches = 10_000usize;

    let matcher: Box<dyn Fn(&str) -> Vec<(usize, usize)> + Send> = if is_regex {
        let pattern = if case_sensitive {
            regex::Regex::new(&query)
        } else {
            regex::RegexBuilder::new(&query).case_insensitive(true).build()
        }.map_err(|e| e.to_string())?;
        Box::new(move |line: &str| {
            pattern.find_iter(line).map(|m| (m.start(), m.end())).collect()
        })
    } else {
        let q = if case_sensitive { query.clone() } else { query.to_lowercase() };
        let cs = case_sensitive;
        Box::new(move |line: &str| {
            let haystack = if cs { line.to_string() } else { line.to_lowercase() };
            let mut positions = Vec::new();
            let mut start = 0;
            while let Some(pos) = haystack[start..].find(&q) {
                let abs = start + pos;
                if whole_word {
                    let before_ok = abs == 0 || !haystack.as_bytes()[abs - 1].is_ascii_alphanumeric();
                    let after_ok = abs + q.len() >= haystack.len() || !haystack.as_bytes()[abs + q.len()].is_ascii_alphanumeric();
                    if before_ok && after_ok {
                        positions.push((abs, abs + q.len()));
                    }
                } else {
                    positions.push((abs, abs + q.len()));
                }
                start = abs + 1;
            }
            positions
        })
    };

    let include_glob = include_pattern.as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| glob::Pattern::new(p))
        .transpose().map_err(|e| e.to_string())?;
    let exclude_glob = exclude_pattern.as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| glob::Pattern::new(p))
        .transpose().map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    let mut total_matches = 0usize;
    let mut truncated = false;

    for entry in WalkDir::new(&workspace_path)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                if name.starts_with('.') { return false; }
                if skip_dirs.contains(&name.as_ref()) { return false; }
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if total_matches >= max_matches { truncated = true; break; }
        if entry.file_type().is_dir() { continue; }

        let path_str = entry.path().to_string_lossy().to_string();
        let rel = path_str.strip_prefix(&workspace_path).unwrap_or(&path_str).trim_start_matches('/');

        if let Some(ref pat) = include_glob {
            if !pat.matches(rel) { continue; }
        }
        if let Some(ref pat) = exclude_glob {
            if pat.matches(rel) { continue; }
        }

        // Extension filter (cheap; happens before file read)
        if let Some(ref exts) = file_extensions {
            if !exts.is_empty() {
                let ext_matches = entry.path().extension()
                    .and_then(|e| e.to_str())
                    .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
                    .unwrap_or(false);
                if !ext_matches { continue; }
            }
        }

        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut file_matches = Vec::new();
        for (line_num, line) in content.lines().enumerate() {
            let positions = matcher(line);
            for (ms, me) in positions {
                file_matches.push(SearchMatch {
                    line_number: line_num + 1,
                    line_content: line.to_string(),
                    match_start: ms,
                    match_end: me,
                });
                total_matches += 1;
                if total_matches >= max_matches { truncated = true; break; }
            }
            if truncated { break; }
        }

        if !file_matches.is_empty() {
            results.push(FileSearchResult { path: path_str, matches: file_matches });
        }
        if truncated { break; }
    }

    let file_count = results.len();
    Ok(SearchResults { results, total_matches, file_count, truncated })
}
