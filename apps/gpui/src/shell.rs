use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::{prelude::FluentBuilder, *};
use quench_app::{App as Quench, ContextView, Cost, MachineView, RecentView, Row};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const BG: u32 = 0x0e0f13;
const RAIL: u32 = 0x16181f;
const BORDER: u32 = 0x23262f;
const TEXT: u32 = 0xe7e9ee;
const MUTED: u32 = 0x8b90a0;
const FAINT: u32 = 0x5a5f6e;
const ACCENT: u32 = 0x6ea8fe;

enum Line {
    Heading(String, usize),
    Item(Row),
}

pub struct Shell {
    quench: Quench,
    machine: MachineView,
    recent: Vec<RecentView>,
    view: Option<ContextView>,
    lines: Rc<Vec<Line>>,
    list: ListState,
    error: Option<String>,
}

impl Shell {
    pub fn new(quench: Quench, launch: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        let machine = quench.machine();
        let recent = quench.recent();
        let mut shell = Shell {
            quench,
            machine,
            recent,
            view: None,
            lines: Rc::new(Vec::new()),
            list: ListState::new(0, ListAlignment::Top, px(600.)),
            error: None,
        };
        if let Some(path) = launch.or_else(|| shell.recent.first().map(|r| PathBuf::from(&r.path)))
        {
            shell.open(&path, cx);
        }
        shell
    }

    fn open(&mut self, path: &Path, cx: &mut Context<Self>) {
        if !path.is_dir() {
            self.error = Some(format!("{} is not a folder", path.display()));
            cx.notify();
            return;
        }
        match self.quench.open_project(path) {
            Ok(view) => {
                let lines: Vec<Line> = view
                    .sections
                    .iter()
                    .flat_map(|s| {
                        std::iter::once(Line::Heading(s.title.clone(), s.rows.len()))
                            .chain(s.rows.iter().cloned().map(Line::Item))
                    })
                    .collect();
                self.list.reset(lines.len());
                self.lines = Rc::new(lines);
                self.view = Some(view);
                self.recent = self.quench.recent();
                self.error = None;
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    fn pick(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open project".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(mut picked))) = paths.await {
                if let Some(path) = picked.pop() {
                    let _ = this.update(cx, |shell, cx| shell.open(&path, cx));
                }
            }
        })
        .detach();
    }

    fn rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.view.as_ref().map(|v| v.project.label.clone());
        div()
            .w(px(232.))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .p_4()
            .bg(rgb(RAIL))
            .border_r_1()
            .border_color(rgb(BORDER))
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .mb_2()
                    .child("Quench"),
            )
            .child(
                Button::new("open")
                    .primary()
                    .label("Open project…")
                    .on_click(cx.listener(|this, _, _, cx| this.pick(cx))),
            )
            .child(div().id("recent").flex_1().overflow_y_scroll().children(
                self.recent.iter().enumerate().map(|(ix, r)| {
                    let path = PathBuf::from(&r.path);
                    let active = current.as_deref() == Some(r.label.as_str());
                    div()
                        .id(("recent", ix))
                        .p_2()
                        .mt_1()
                        .rounded_md()
                        .cursor_pointer()
                        .when(active, |d| d.border_1().border_color(rgb(BORDER)))
                        .hover(|d| d.bg(rgba(0xffffff08)))
                        .on_click(cx.listener(move |this, _, _, cx| this.open(&path, cx)))
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(r.label.clone()),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(rgb(MUTED))
                                .truncate()
                                .child(r.path.clone()),
                        )
                }),
            ))
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(FAINT))
                    .child(self.machine.label.clone()),
            )
    }

    fn stage(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(view) = &self.view else {
            return div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .child("Open a project to see what Claude Code loads there.")
                .when_some(self.error.clone(), |d, e| {
                    d.child(div().text_color(rgb(0xf38ba8)).child(e))
                })
                .child(
                    Button::new("open-empty")
                        .label("Open project…")
                        .on_click(cx.listener(|this, _, _, cx| this.pick(cx))),
                )
                .into_any_element();
        };
        let lines = self.lines.clone();
        div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .px_10()
            .pt_8()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .pb_4()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .child(
                        div()
                            .child(
                                div()
                                    .text_2xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(view.project.label.clone()),
                            )
                            .child(div().text_sm().text_color(rgb(MUTED)).child(format!(
                                "{} · {}",
                                view.project.path, view.project.identity
                            ))),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_end()
                            .child(
                                div()
                                    .text_2xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("~{}", view.always_tokens)),
                            )
                            .child(div().text_xs().text_color(rgb(MUTED)).child(format!(
                                "tokens always loaded in {} ({})",
                                view.harness, view.token_method
                            ))),
                    ),
            )
            .when_some(self.error.clone(), |d, e| {
                d.child(div().text_color(rgb(0xf38ba8)).child(e))
            })
            .child(
                list(self.list.clone(), move |ix, _, _| match &lines[ix] {
                    Line::Heading(title, count) => div()
                        .pt_6()
                        .pb_2()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!("{} {count}", title.to_uppercase()))
                        .into_any_element(),
                    Line::Item(row) => row_element(row).into_any_element(),
                })
                .flex_1(),
            )
            .into_any_element()
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .bg(rgb(BG))
            .text_color(rgb(TEXT))
            .child(self.rail(cx))
            .child(self.stage(cx))
    }
}

fn row_element(row: &Row) -> impl IntoElement {
    let location = std::iter::once(row.location.clone())
        .chain(row.notes.iter().cloned())
        .collect::<Vec<_>>()
        .join(" · ");
    div()
        .py_2()
        .border_b_1()
        .border_color(rgb(BORDER))
        .child(
            div()
                .flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(row.title.clone()),
                )
                .child(
                    div()
                        .px_1()
                        .text_xs()
                        .text_color(rgb(MUTED))
                        .border_1()
                        .border_color(rgb(BORDER))
                        .rounded_md()
                        .child(row.scope.clone()),
                )
                .child(div().flex_1())
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(MUTED))
                        .child(cost_label(&row.cost)),
                ),
        )
        .when_some(row.detail.clone(), |d, detail| {
            d.child(div().text_sm().text_color(rgb(MUTED)).child(detail))
        })
        .child(
            div()
                .text_xs()
                .text_color(rgb(ACCENT))
                .truncate()
                .child(location),
        )
}

fn cost_label(cost: &Cost) -> String {
    match cost {
        Cost::Duplicate => "counted once".to_string(),
        Cost::Unknown => "cost unknown".to_string(),
        Cost::Estimated {
            always_tokens: 0,
            on_demand_tokens: 0,
        } => "0 tok".to_string(),
        Cost::Estimated {
            always_tokens: 0,
            on_demand_tokens,
        } => format!("{on_demand_tokens} on use only"),
        Cost::Estimated {
            always_tokens,
            on_demand_tokens: 0,
        } => format!("~{always_tokens} tok"),
        Cost::Estimated {
            always_tokens,
            on_demand_tokens,
        } => format!("~{always_tokens} tok · {on_demand_tokens} on use"),
    }
}
