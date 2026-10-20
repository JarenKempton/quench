mod shell;

use gpui_kit::*;

fn main() {
    let launch = std::env::args().nth(1).map(std::path::PathBuf::from);
    let app = quench_app::App::for_this_user().expect("Quench could not create ~/.quench/local");
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1100.), px(720.)),
                cx,
            ))),
            titlebar: Some(TitlebarOptions {
                title: Some("Quench".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |_, cx| {
            cx.new(|cx| shell::Shell::new(app, launch, cx))
        })
        .expect("open window");
    });
}
