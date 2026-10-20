use crate::home::QuenchHome;
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub v: u32,
    pub id: String,
    pub label: String,
}

impl Machine {
    pub fn load_or_create(home: &QuenchHome) -> std::io::Result<Machine> {
        let path = home.local().join("machine.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => return parse(&path, &text),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            Err(_) => {}
        }
        std::fs::create_dir_all(home.local())?;
        let machine = Machine {
            v: 1,
            id: uuid_v4()?,
            label: hostname(),
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&serde_json::to_vec_pretty(&machine)?)?;
                file.sync_all()?;
                Ok(machine)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                parse(&path, &std::fs::read_to_string(&path)?)
            }
            Err(e) => Err(e),
        }
    }
}

fn parse(path: &std::path::Path, text: &str) -> std::io::Result<Machine> {
    serde_json::from_str(text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "{} is unreadable ({e}); Quench won't replace this machine's id. Fix or delete the file.",
                path.display()
            ),
        )
    })
}

fn uuid_v4() -> std::io::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| std::io::Error::other(e.to_string()))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        })
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "this machine".to_string())
}
