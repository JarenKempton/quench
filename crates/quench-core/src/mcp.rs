use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpScope {
    User,
    Local,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Approved,
    Denied,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpServer {
    pub name: String,
    pub config_scope: McpScope,
    pub source: PathBuf,
    pub transport: Transport,
    pub endpoint: Option<String>,
    pub arg_count: usize,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub approval: Option<Approval>,
}

pub fn claude_code_mcp_servers(
    home: &Path,
    project_root: &Path,
    project_keys: &[PathBuf],
) -> Vec<McpServer> {
    let user_file = home.join(".claude.json");
    let user = read_json(&user_file);
    let mut out = Vec::new();

    if let Some(servers) = user.get("mcpServers").and_then(Value::as_object) {
        out.extend(
            servers
                .iter()
                .map(|(n, v)| server(n, v, McpScope::User, &user_file, None)),
        );
    }

    let project_entry = project_keys
        .iter()
        .find_map(|k| {
            user.get("projects")
                .and_then(|p| p.get(k.to_string_lossy().as_ref()))
        })
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(servers) = project_entry.get("mcpServers").and_then(Value::as_object) {
        out.extend(
            servers
                .iter()
                .map(|(n, v)| server(n, v, McpScope::Local, &user_file, None)),
        );
    }

    let project_file = project_root.join(".mcp.json");
    let project = read_json(&project_file);
    if let Some(servers) = project.get("mcpServers").and_then(Value::as_object) {
        let settings = [
            project_entry.clone(),
            read_json(&project_root.join(".claude/settings.local.json")),
            read_json(&project_root.join(".claude/settings.json")),
            read_json(&home.join(".claude/settings.json")),
        ];
        out.extend(servers.iter().map(|(n, v)| {
            server(
                n,
                v,
                McpScope::Project,
                &project_file,
                Some(approval(n, &settings)),
            )
        }));
    }
    out
}

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn approval(name: &str, layers: &[Value]) -> Approval {
    let listed = |v: &Value, key: &str| {
        v.get(key)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name)))
    };
    for layer in layers {
        if listed(layer, "disabledMcpjsonServers") {
            return Approval::Denied;
        }
        if listed(layer, "enabledMcpjsonServers")
            || layer.get("enableAllProjectMcpServers") == Some(&Value::Bool(true))
        {
            return Approval::Approved;
        }
    }
    Approval::Pending
}

fn server(
    name: &str,
    v: &Value,
    config_scope: McpScope,
    source: &Path,
    approval: Option<Approval>,
) -> McpServer {
    let empty = Map::new();
    let obj = v.as_object().unwrap_or(&empty);
    let url = obj.get("url").and_then(Value::as_str);
    let command = obj.get("command").and_then(Value::as_str);
    let transport = match obj.get("type").and_then(Value::as_str) {
        Some("stdio") => Transport::Stdio,
        Some("http") => Transport::Http,
        Some("sse") => Transport::Sse,
        None if command.is_some() => Transport::Stdio,
        _ => Transport::Unknown,
    };
    McpServer {
        name: name.to_string(),
        config_scope,
        source: source.to_path_buf(),
        transport,
        endpoint: url.map(redact_url).or_else(|| command.map(program)),
        arg_count: obj
            .get("args")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        env_keys: keys(obj.get("env")),
        header_keys: keys(obj.get("headers")),
        approval,
    }
}

fn keys(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

fn program(command: &str) -> String {
    let first = command.split_whitespace().next().unwrap_or(command);
    Path::new(first)
        .file_name()
        .map_or(first.to_string(), |n| n.to_string_lossy().into_owned())
}

fn redact_url(url: &str) -> String {
    let url = url.split(['?', '#']).next().unwrap_or(url);
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
            format!("{scheme}://{rest}")
        }
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("quench-mcp-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn reads_user_local_and_project_servers_without_leaking_secrets() {
        let r = root("all");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&proj).unwrap();
        let claude_json = serde_json::json!({
            "mcpServers": {
                "docs": {"type": "http", "url": "https://bob:hunter2@mcp.example.com/v1?token=SECRET123#frag",
                         "headers": {"Authorization": "Bearer SECRET456"}}
            },
            "projects": {
                proj.to_string_lossy(): {
                    "mcpServers": {"jira": {"type": "sse", "url": "https://jira.example.com/sse"}},
                    "enabledMcpjsonServers": ["db"]
                }
            }
        });
        fs::write(home.join(".claude.json"), claude_json.to_string()).unwrap();
        fs::write(
            proj.join(".mcp.json"),
            serde_json::json!({"mcpServers": {
                "db": {"command": "/usr/local/bin/pg-mcp --password SECRET789", "args": ["--dsn", "postgres://u:SECRET000@db"],
                       "env": {"PGPASSWORD": "SECRET111"}},
                "new": {"command": "npx", "args": ["some-mcp"]}
            }})
            .to_string(),
        )
        .unwrap();

        let servers = claude_code_mcp_servers(&home, &proj, std::slice::from_ref(&proj));
        let names: Vec<(&str, McpScope, Option<Approval>)> = servers
            .iter()
            .map(|s| (s.name.as_str(), s.config_scope, s.approval))
            .collect();
        assert_eq!(
            names,
            vec![
                ("docs", McpScope::User, None),
                ("jira", McpScope::Local, None),
                ("db", McpScope::Project, Some(Approval::Approved)),
                ("new", McpScope::Project, Some(Approval::Pending)),
            ]
        );
        assert_eq!(
            servers[0].endpoint.as_deref(),
            Some("https://mcp.example.com/v1")
        );
        assert_eq!(servers[0].header_keys, vec!["Authorization"]);
        assert_eq!(servers[2].endpoint.as_deref(), Some("pg-mcp"));
        assert_eq!(servers[2].transport, Transport::Stdio);
        assert_eq!(servers[2].env_keys, vec!["PGPASSWORD"]);

        let serialized = serde_json::to_string(&servers).unwrap();
        for secret in ["hunter2", "SECRET", "bob:"] {
            assert!(
                !serialized.contains(secret),
                "{secret} leaked: {serialized}"
            );
        }
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn denial_in_a_stronger_layer_wins() {
        let r = root("deny");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(proj.join(".claude")).unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"enableAllProjectMcpServers": true}"#,
        )
        .unwrap();
        fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"disabledMcpjsonServers": ["x"]}"#,
        )
        .unwrap();
        fs::write(
            proj.join(".mcp.json"),
            r#"{"mcpServers": {"x": {"command": "x"}, "y": {"command": "y"}}}"#,
        )
        .unwrap();
        let servers = claude_code_mcp_servers(&home, &proj, std::slice::from_ref(&proj));
        assert_eq!(servers[0].approval, Some(Approval::Denied));
        assert_eq!(servers[1].approval, Some(Approval::Approved));
        let _ = fs::remove_dir_all(&r);
    }
}
