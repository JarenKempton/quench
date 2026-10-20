//! `cargo run -p quench-core --example scan` — run the real scanner against this
//! machine and print a summary. This is the same `scan_this_machine()` call the
//! desktop's `scan` command makes, so it proves the data is real end-to-end
//! without launching the GUI (quench#13).

fn main() {
    let scan = quench_core::scan_this_machine();

    for h in &scan.harnesses {
        println!(
            "{:<12} home={:<5} skills_dir={:<5} skills={} dangling={} context={}",
            h.id,
            h.home.present,
            h.skills_dir.present,
            h.skills.len(),
            h.dangling.len(),
            h.context_files.len(),
        );
        if let Some(first) = h.skills.first() {
            println!(
                "             e.g. {} — origin {:?}",
                first.name, first.origin
            );
        }
    }

    println!("\nproject root: {}", scan.project.root.display());
    println!("project skills (strays): {}", scan.project.skills.len());
    println!("cross-harness duplicate names: {:?}", scan.duplicate_names);
}
