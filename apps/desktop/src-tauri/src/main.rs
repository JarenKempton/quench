// Prevents an extra console window on Windows in release. Does nothing on other targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hone_lib::run()
}
