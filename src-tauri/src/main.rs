// No console window on Windows in release builds (the splash is the only thing the user sees).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    salisbury_re_desk_lib::run()
}
