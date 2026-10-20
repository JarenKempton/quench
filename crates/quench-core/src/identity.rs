use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityMethod {
    RootCommit,
    Remote,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectKey {
    pub v: u32,
    pub method: IdentityMethod,
    pub value: String,
    pub label: String,
}

impl ProjectKey {
    pub fn file_stem(&self) -> String {
        let method = match self.method {
            IdentityMethod::RootCommit => "root",
            IdentityMethod::Remote => "remote",
            IdentityMethod::Path => "path",
        };
        let value: String = self
            .value
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        format!("{method}-{value}")
    }
}

pub fn project_key(working_copy: &Path) -> ProjectKey {
    let path = std::fs::canonicalize(working_copy).unwrap_or_else(|_| working_copy.to_path_buf());
    let remote = git(&path, &["remote"])
        .map(|names| preferred_remote(&path, &names))
        .unwrap_or(None);
    let label = remote
        .as_deref()
        .and_then(|r| r.split_once('/').map(|(_, rest)| rest.to_string()))
        .unwrap_or_else(|| {
            path.file_name().map_or_else(
                || path.display().to_string(),
                |n| n.to_string_lossy().into_owned(),
            )
        });

    let (method, value) = if let Some(root) = root_commit(&path) {
        (IdentityMethod::RootCommit, root)
    } else if let Some(remote) = remote {
        (IdentityMethod::Remote, remote)
    } else {
        (
            IdentityMethod::Path,
            format!("{:016x}", fnv1a(path.to_string_lossy().as_bytes())),
        )
    };
    ProjectKey {
        v: 1,
        method,
        value,
        label,
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn root_commit(dir: &Path) -> Option<String> {
    if git(dir, &["rev-parse", "--is-shallow-repository"]).as_deref() != Some("false") {
        return None;
    }
    let roots = git(dir, &["log", "--max-parents=0", "--format=%ct %H", "HEAD"])?;
    roots
        .lines()
        .filter_map(|l| {
            l.split_once(' ')
                .and_then(|(t, h)| Some((t.parse::<i64>().ok()?, h.to_string())))
        })
        .min()
        .map(|(_, h)| h)
}

fn preferred_remote(dir: &Path, names: &str) -> Option<String> {
    let mut names: Vec<&str> = names.lines().collect();
    names.sort_by_key(|n| match *n {
        "upstream" => (0, *n),
        "origin" => (1, *n),
        _ => (2, *n),
    });
    names
        .into_iter()
        .filter_map(|n| git(dir, &["remote", "get-url", n]))
        .find_map(|url| normalize_remote(&url))
}

pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty()
        || url.starts_with('/')
        || url.starts_with('.')
        || url.starts_with("file:")
        || url == "."
    {
        return None;
    }
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => url.replacen(':', "/", 1),
    };
    let rest = rest.rsplit_once('@').map_or(rest.as_str(), |(_, r)| r);
    let (host, path) = rest.split_once('/')?;
    let host = host.split(':').next().unwrap_or(host);
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{}/{}", host, path).to_lowercase())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn root(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("quench-identity-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::canonicalize(base).unwrap()
    }

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        sh(dir, &["init", "-q"]);
        fs::write(dir.join("a"), "1").unwrap();
        sh(dir, &["add", "."]);
        sh(dir, &["commit", "-qm", "one"]);
        fs::write(dir.join("a"), "2").unwrap();
        sh(dir, &["commit", "-qam", "two"]);
    }

    #[test]
    fn root_commit_survives_move_clone_and_remote_change() {
        let r = root("root");
        let a = r.join("a");
        repo(&a);
        sh(
            &a,
            &["remote", "add", "origin", "git@github.com:Acme/Api.git"],
        );
        let first = project_key(&a);
        assert_eq!(first.method, IdentityMethod::RootCommit);
        assert_eq!(first.label, "acme/api");

        fs::rename(&a, r.join("moved")).unwrap();
        let moved = r.join("moved");
        assert_eq!(project_key(&moved).value, first.value);

        sh(&r, &["clone", "-q", moved.to_str().unwrap(), "clone"]);
        assert_eq!(project_key(&r.join("clone")).value, first.value);

        sh(
            &moved,
            &[
                "remote",
                "set-url",
                "origin",
                "https://gitlab.com/other/name",
            ],
        );
        let relabeled = project_key(&moved);
        assert_eq!(relabeled.value, first.value);
        assert_eq!(relabeled.label, "other/name");
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn shallow_clone_falls_back_to_the_remote_and_ignores_local_remotes() {
        let r = root("shallow");
        let src = r.join("src");
        repo(&src);
        let url = format!("file://{}", src.display());
        sh(&r, &["clone", "-q", "--depth", "1", &url, "shallow"]);
        let shallow = r.join("shallow");
        let local_only = project_key(&shallow);
        assert_eq!(
            local_only.method,
            IdentityMethod::Path,
            "file:// remote is not an identity"
        );

        sh(
            &shallow,
            &[
                "remote",
                "add",
                "upstream",
                "https://github.com/Acme/Api.git/",
            ],
        );
        let key = project_key(&shallow);
        assert_eq!(
            (key.method, key.value.as_str()),
            (IdentityMethod::Remote, "github.com/acme/api")
        );
        assert_eq!(key.file_stem(), "remote-github.com-acme-api");
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn non_git_directories_are_keyed_by_their_real_path() {
        let r = root("plain");
        let dir = r.join("notes");
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&dir, r.join("alias")).unwrap();
        let key = project_key(&dir);
        assert_eq!(key.method, IdentityMethod::Path);
        assert_eq!(key.label, "notes");
        assert_eq!(
            project_key(&r.join("alias")),
            key,
            "symlink alias is the same project"
        );
        assert_eq!(
            key.value,
            format!("{:016x}", fnv1a(dir.to_string_lossy().as_bytes()))
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn remote_urls_normalize_across_forms() {
        for url in [
            "git@github.com:Acme/Api.git",
            "https://github.com/acme/api",
            "ssh://git@github.com:22/Acme/Api.git",
            "https://user:pw@github.com/Acme/Api.git/",
        ] {
            assert_eq!(
                normalize_remote(url).as_deref(),
                Some("github.com/acme/api"),
                "{url}"
            );
        }
        for local in [".", "/srv/repo.git", "../sibling", "file:///tmp/x"] {
            assert_eq!(normalize_remote(local), None, "{local}");
        }
    }
}
