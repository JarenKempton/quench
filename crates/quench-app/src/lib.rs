mod home;
mod machine;
mod recent;
mod view;

pub use home::QuenchHome;
pub use machine::Machine;
pub use recent::{Recent, RecentProject};
pub use view::{
    context_view, tilde, ContextView, Cost, MachineView, ProjectHeader, RecentView, Row, Section,
};

use std::path::{Path, PathBuf};

pub struct App {
    home: PathBuf,
    quench: QuenchHome,
    machine: Machine,
}

impl App {
    pub fn new(home: &Path, quench: QuenchHome) -> std::io::Result<App> {
        let machine = Machine::load_or_create(&quench)?;
        Ok(App {
            home: home.to_path_buf(),
            quench,
            machine,
        })
    }

    pub fn for_this_user() -> std::io::Result<App> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let quench = QuenchHome::for_user(&home);
        App::new(&home, quench)
    }

    pub fn machine(&self) -> MachineView {
        MachineView {
            id: self.machine.id.clone(),
            label: self.machine.label.clone(),
        }
    }

    pub fn recent(&self) -> Vec<RecentView> {
        Recent::load(&self.quench)
            .projects
            .into_iter()
            .map(|p| RecentView {
                path: p.path.display().to_string(),
                label: p.label,
            })
            .collect()
    }

    pub fn open_project(&self, path: &Path) -> std::io::Result<ContextView> {
        let load = quench_core::claude_code_context(&self.home, path);
        Recent::touch(&self.quench, &load.project_root, &load.project)?;
        Ok(context_view(&load, &self.home))
    }
}
