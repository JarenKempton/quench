mod changes;
mod home;
mod machine;
mod recent;
mod view;

pub use changes::{ChangesView, FileDiffView, JournalEntry, PendingView, StagedChange};
pub use home::QuenchHome;
pub use machine::Machine;
pub use recent::{Recent, RecentProject};
pub use view::{
    context_view, tilde, ContextView, Cost, MachineView, ProjectHeader, RecentView, Row, Section,
};

use quench_core::SkillOverride;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct App {
    home: PathBuf,
    quench: QuenchHome,
    machine: Machine,
    pending: Mutex<Vec<StagedChange>>,
}

impl App {
    pub fn new(home: &Path, quench: QuenchHome) -> std::io::Result<App> {
        let machine = Machine::load_or_create(&quench)?;
        Ok(App {
            home: home.to_path_buf(),
            quench,
            machine,
            pending: Mutex::new(Vec::new()),
        })
    }

    pub fn for_this_user() -> std::io::Result<App> {
        let home = quench_core::home_dir().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no home directory (HOME is unset)",
            )
        })?;
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
        let _ = Recent::touch(&self.quench, &load.project_root, &load.project);
        let mut view = context_view(&load, &self.home);
        let file = quench_core::local_settings(&self.home, &load.project_root);
        let pending = self.pending();
        for row in view.sections.iter_mut().flat_map(|s| s.rows.iter_mut()) {
            if let Some(toggle) = row.toggle.as_mut() {
                toggle.pending = pending
                    .iter()
                    .find(|c| c.file == file && c.skill == toggle.skill)
                    .map(|c| changes::label(&c.to));
            }
        }
        Ok(view)
    }

    pub fn stage_skill(
        &self,
        path: &Path,
        skill: &str,
        to: Option<&str>,
    ) -> std::io::Result<ChangesView> {
        if let Some(value) = to {
            if SkillOverride::parse(value).is_none() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("{value} is not a skillOverrides value"),
                ));
            }
        }
        let root = std::fs::canonicalize(path)?;
        let file = quench_core::local_settings(&self.home, &root);
        let from = quench_core::read_overrides(&file)
            .into_iter()
            .find(|(name, _)| name == skill)
            .map(|(_, v)| v.as_str().to_string());
        let to = to.map(str::to_string);
        {
            let mut pending = self.pending.lock().expect("pending lock");
            pending.retain(|c| !(c.file == file && c.skill == skill));
            if from != to {
                pending.push(StagedChange {
                    project: quench_core::project_key(&root),
                    working_copy: root,
                    file,
                    machine: self.machine.id.clone(),
                    harness: "claude-code".to_string(),
                    skill: skill.to_string(),
                    from,
                    to,
                });
            }
        }
        Ok(self.changes())
    }

    pub fn changes(&self) -> ChangesView {
        changes::changes_view(&self.pending(), &self.quench, &self.home)
    }

    pub fn discard(&self) -> ChangesView {
        self.pending.lock().expect("pending lock").clear();
        self.changes()
    }

    pub fn apply(&self) -> std::io::Result<ChangesView> {
        let pending = self.pending();
        if !pending.is_empty() {
            changes::apply(&pending, &self.quench)?;
            self.pending.lock().expect("pending lock").clear();
        }
        Ok(self.changes())
    }

    pub fn undo_last(&self) -> std::io::Result<ChangesView> {
        changes::undo_last(&self.quench)?;
        Ok(self.changes())
    }

    fn pending(&self) -> Vec<StagedChange> {
        self.pending.lock().expect("pending lock").clone()
    }
}
