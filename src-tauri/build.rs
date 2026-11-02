fn main() {
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    for (name, define, wrapper) in
        [("credential-helper", Some("CREDENTIAL_HELPER"), false), ("askpass", None, false), ("ssh-wrapper", None, true)]
    {
        let target = out.join(format!("{name}{}", if windows { ".exe" } else { "" }));
        let compiler = cc::Build::new().get_compiler();
        let mut command = compiler.to_command();
        command.arg("-Inative/desktop-trampoline/include");
        if windows {
            command.arg("-DWINDOWS");
        }
        if let Some(define) = define {
            command.arg(format!("-D{define}"));
        }
        if wrapper {
            command.arg("native/desktop-trampoline/src/ssh-wrapper.c");
        } else {
            command
                .args(["native/desktop-trampoline/src/desktop-trampoline.c", "native/desktop-trampoline/src/socket.c"]);
        }
        if compiler.is_like_msvc() {
            command.arg(format!("/Fe:{}", target.display()));
            if windows && !wrapper {
                command.arg("Ws2_32.lib");
            }
        } else {
            command.arg("-o").arg(&target);
            if windows && !wrapper {
                command.arg("-lws2_32");
            }
        }
        assert!(command.status().expect("compile upstream trampoline").success(), "trampoline compilation failed");
        println!("cargo:rustc-env=GITCUB_{}_PATH={}", name.replace('-', "_").to_uppercase(), target.display());
    }
    println!("cargo:rerun-if-changed=native/desktop-trampoline");
    let destination = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join(
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { "printenvz.exe" } else { "printenvz" },
    );
    let compiler = cc::Build::new().get_compiler();
    let mut command = compiler.to_command();
    command.arg("native/printenvz/printenvz.c");
    if compiler.is_like_msvc() {
        command.arg(format!("/Fe:{}", destination.display()));
    } else {
        command.arg("-o").arg(&destination);
    }
    assert!(command.status().expect("compile printenvz").success(), "printenvz compilation failed");
    println!("cargo:rustc-env=GITCUB_PRINTENVZ_PATH={}", destination.display());
    println!("cargo:rerun-if-changed=native/printenvz/printenvz.c");
    if windows {
        cc::Build::new().file("native/desktop-credentials/read_windows.c").compile("gitcub_desktop_credentials");
        println!("cargo:rustc-link-lib=Advapi32");
        println!("cargo:rerun-if-changed=native/desktop-credentials");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/desktop-credentials/read.m")
            .flag("-fobjc-arc")
            .compile("gitcub_desktop_credentials");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rerun-if-changed=native/desktop-credentials");
        // Keep the pinned Desktop source intact. The SDK replaces its legacy
        // foreground alert option with list + banner on our macOS baseline.
        let notifications = std::fs::read_to_string("native/desktop-notifications/GHDesktopNotificationsManager.m")
            .expect("read upstream notification manager");
        let legacy_option = "UNNotificationPresentationOptionAlert";
        assert_eq!(notifications.matches(legacy_option).count(), 1, "review upstream notification adaptation");
        let adapted_notifications = out.join("GHDesktopNotificationsManager.m");
        std::fs::write(
            &adapted_notifications,
            notifications.replace(
                legacy_option,
                "(UNNotificationPresentationOptionList | UNNotificationPresentationOptionBanner)",
            ),
        )
        .expect("write macOS notification adapter");
        cc::Build::new()
            .include("native/desktop-notifications")
            .file(adapted_notifications)
            .file("native/desktop-notifications/bridge.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("gitcub_desktop_notifications");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=native/desktop-notifications");
    }

    let pattern = if std::env::var_os("CARGO_FEATURE_HASGARD_TESTING").is_some() {
        "./capabilities/**/*.json"
    } else {
        "./capabilities/*.json"
    };
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern))
        .expect("failed to build Tauri capabilities");
}
