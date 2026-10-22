// 桌面入口。真正的逻辑在 lib.rs —— 这样拆是为了以后要加移动端时不用重排。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jms_client_lib::run()
}
