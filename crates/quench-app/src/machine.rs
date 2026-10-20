use crate::home::{read_json, write_json, QuenchHome};
use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub v: u32,
    pub id: String,
    pub label: String,
}

impl Machine {
    pub fn load_or_create(home: &QuenchHome) -> std::io::Result<Machine> {
        let path = home.local().join("machine.json");
        if let Some(machine) = read_json::<Machine>(&path) {
            return Ok(machine);
        }
        let machine = Machine {
            v: 1,
            id: uuid_v4()?,
            label: hostname(),
        };
        write_json(&path, &machine)?;
        Ok(machine)
    }
}

fn uuid_v4() -> std::io::Result<String> {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
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
