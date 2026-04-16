use eframe::egui;

pub mod parse;
pub mod unify;

pub struct SlideApp {
    text: String,
}

impl Default for SlideApp {
    fn default() -> Self {
        Self {
            text: "- foo X\n  - bar\n\n- root\n  - foo a\n    - bar\n  - foo b\n    - bar\n"
                .to_string(),
        }
    }
}

fn compute_output(text: &str) -> String {
    let trees = match parse::parse(text) {
        Ok(t) => t,
        Err(e) => return format!("parse error line {}: {}", e.line, e.message),
    };
    if trees.len() < 2 {
        return format!(
            "need 2 top-level trees (pattern then reference); got {}",
            trees.len()
        );
    }
    let pattern = &trees[0];
    let reference = &trees[1];
    let matches = unify::unify_term(pattern, reference);
    if matches.is_empty() {
        return "no matches".to_string();
    }
    let mut out = format!("{} match(es)\n\n", matches.len());
    for (i, m) in matches.iter().enumerate() {
        out.push_str(&format!("match {}:\n", i + 1));
        out.push_str("  substitution:\n");
        let mut keys: Vec<&String> = m.substitution.keys().collect();
        keys.sort();
        if keys.is_empty() {
            out.push_str("    (empty)\n");
        } else {
            for k in keys {
                let resolved = unify::resolve(&unify::Term::Variable(k.clone()), &m.substitution);
                out.push_str(&format!("    {} -> {}\n", k, parse::format_term(&resolved)));
            }
        }
        out.push_str("  root:\n");
        for line in parse::format_tree(m.root_image).lines() {
            out.push_str("    ");
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

impl eframe::App for SlideApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ctx.set_pixels_per_point(1.5);
        ctx.style_mut(|s| {
            let v = &mut s.visuals;
            v.override_text_color = Some(egui::Color32::from_gray(230));
            v.extreme_bg_color = egui::Color32::from_gray(30); // text edit background
            // v.extreme_bg_color = egui::Color32::BLACK; // text edit background
            v.widgets.noninteractive.bg_fill = egui::Color32::BLACK;
            v.widgets.inactive.bg_fill = egui::Color32::from_gray(30);
            v.widgets.inactive.weak_bg_fill = egui::Color32::from_gray(30);
            v.widgets.hovered.bg_fill = egui::Color32::from_gray(55);
            v.widgets.hovered.weak_bg_fill = egui::Color32::from_gray(55);
            v.widgets.active.bg_fill = egui::Color32::from_gray(80);
            v.widgets.active.weak_bg_fill = egui::Color32::from_gray(80);
        });
        egui::CentralPanel::default()
            .frame(egui::Frame::default().fill(egui::Color32::BLACK))
            .show(ctx, |ui| {
                let half = ui.available_height() / 2.0;
                let width = ui.available_width();

                ui.add_sized(
                    [width, half],
                    egui::TextEdit::multiline(&mut self.text)
                        .font(egui::TextStyle::Monospace)
                        .code_editor(),
                );

                let mut output = compute_output(&self.text);
                ui.add_sized(
                    [width, half],
                    egui::TextEdit::multiline(&mut output)
                        .font(egui::TextStyle::Monospace)
                        .interactive(false),
                );
            });
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub async fn start() -> Result<(), wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast;
    let canvas = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("the_canvas_id"))
        .and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok())
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("canvas not found"))?;

    eframe::WebRunner::new()
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(|_cc| Ok(Box::new(SlideApp::default()))),
        )
        .await
}
