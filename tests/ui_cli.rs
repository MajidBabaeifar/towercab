//! UI-1, UI-2: the loop's server and `towercab ui`.

mod common;

use std::time::Duration;

use common::{output, towercab};
use towercab::config::{Config, IntentsConfig};
use towercab::exes::Exes;
use towercab::home::Home;
use towercab::ui;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn test_loop_serves_ui() {
    let tmp = tempfile::tempdir().unwrap();
    let mut config = Config::new(
        tmp.path().join("config.toml"),
        IntentsConfig {
            remote: None,
            path: tmp.path().join("intents"),
            cutoff: 7,
        },
    );
    config.ui.port = free_port();
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let running = ui::Running::start(&config, &home, &Exes::default(), true).unwrap();
    assert_eq!(running.port(), config.ui.port);
    assert!(ui::answers(config.ui.port));
    // A second one on the same port: logged, no server, the caller goes on.
    assert!(ui::Running::start(&config, &home, &Exes::default(), true).is_none());
    drop(running);
    assert!(!ui::answers(config.ui.port));
}

#[test]
fn test_ui_command() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path();
    let file = user.join("config.toml");
    std::fs::write(&file, "[intents]\npath = \"/nowhere\"\n\n[ui]\nport = 0\n").unwrap();
    let cfg = file.to_str().unwrap();
    let (_, err, code) = output(&mut towercab(user, &["--config", cfg, "ui", "--no-open"]));
    assert_eq!(code, Some(1));
    assert!(err.contains("ui is off: [ui] port = 0"), "{err}");

    // A UI already answering: its URL, exit 0.
    let port = free_port();
    std::fs::write(
        &file,
        format!("[intents]\npath = \"/nowhere\"\n\n[ui]\nport = {port}\n"),
    )
    .unwrap();
    let config = Config::load(Some(&file)).unwrap();
    let home = Home::resolve(Some(&user.join("home"))).unwrap();
    let running = ui::Running::start(&config, &home, &Exes::default(), true).unwrap();
    let (out, err, code) = output(&mut towercab(user, &["--config", cfg, "ui", "--no-open"]));
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(out.trim(), format!("http://127.0.0.1:{port}/"));
    drop(running);

    // None: served here until SIGTERM.
    let mut child = towercab(
        user,
        &[
            "--config",
            cfg,
            "--home",
            home.root.to_str().unwrap(),
            "ui",
            "--no-open",
        ],
    )
    .stdout(std::process::Stdio::piped())
    .spawn()
    .unwrap();
    let t = std::time::Instant::now();
    while !ui::answers(port) && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(ui::answers(port));
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    assert!(child.wait().unwrap().success());
    assert!(!ui::answers(port));
}

#[test]
fn test_ui_yields_to_loop() {
    // A read-only `towercab ui` started while the loop was down steps aside once a loop holds
    // the home, so the loop's own UI (retried every 30 s) gets the port.
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path();
    let file = user.join("config.toml");
    let port = free_port();
    std::fs::write(
        &file,
        format!("[intents]\npath = \"/nowhere\"\n\n[ui]\nport = {port}\n"),
    )
    .unwrap();
    let home = Home::resolve(Some(&user.join("home"))).unwrap();
    let child = towercab(
        user,
        &[
            "--config",
            file.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
            "ui",
            "--no-open",
        ],
    )
    .stdout(std::process::Stdio::piped())
    .spawn()
    .unwrap();
    let t = std::time::Instant::now();
    while !ui::answers(port) && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(ui::answers(port));
    let _lock = home.lock().unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("its UI takes over"), "{text}");
    assert!(!ui::answers(port));
}
