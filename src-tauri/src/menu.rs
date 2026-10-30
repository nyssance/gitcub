//! 应用菜单栏。
//!
//! 条目与快捷键照原版 build-default-menu.ts，一条也不自创：从 GitHub Desktop
//! 过来的人，肌肉记忆和菜单位置都是现成的。
//!
//! 菜单只负责「发一个事件」，具体做什么在前端——同一个动作既能从菜单来，
//! 也能从界面按钮来，逻辑只该有一份。

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// 菜单点击后发给前端的事件名。前端在 app.tsx 里统一接。
pub const EVENT: &str = "menu";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let app_menu = SubmenuBuilder::new(app, "GitCub")
        .about(Some(AboutMetadata::default()))
        .separator()
        .item(&item("preferences", "设置…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "文件")
        .item(&item("new-repository", "新建仓库…", Some("CmdOrCtrl+N"))?)
        .item(&item("add-repository", "添加本地仓库…", Some("CmdOrCtrl+O"))?)
        .item(&item("clone-repository", "克隆仓库…", Some("CmdOrCtrl+Shift+O"))?)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "编辑").undo().redo().separator().cut().copy().paste().select_all().build()?;

    let view = SubmenuBuilder::new(app, "视图")
        .item(&item("show-changes", "更改", Some("CmdOrCtrl+1"))?)
        .item(&item("show-history", "历史", Some("CmdOrCtrl+2"))?)
        .item(&item("show-prs", "合并请求", Some("CmdOrCtrl+3"))?)
        .separator()
        .item(&item("show-repository-list", "仓库列表", Some("CmdOrCtrl+T"))?)
        .item(&item("show-branches-list", "分支列表", Some("CmdOrCtrl+B"))?)
        .item(&item("discover", "发现", None)?)
        .build()?;

    let repository = SubmenuBuilder::new(app, "仓库")
        .item(&item("push", "推送", Some("CmdOrCtrl+P"))?)
        .item(&item("pull", "拉取", Some("CmdOrCtrl+Shift+P"))?)
        .item(&item("fetch", "获取", Some("CmdOrCtrl+Shift+T"))?)
        .separator()
        .item(&item("open-in-editor", "在编辑器中打开", Some("CmdOrCtrl+Shift+A"))?)
        .item(&item("open-in-terminal", "在终端中打开", Some("CmdOrCtrl+Shift+G"))?)
        .item(&item("reveal", "在访达中显示", Some("CmdOrCtrl+Shift+F"))?)
        .separator()
        .item(&item("view-on-remote", "在浏览器中打开", None)?)
        .build()?;

    let branch = SubmenuBuilder::new(app, "分支")
        .item(&item("create-branch", "新建分支…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item("rename-branch", "重命名分支…", None)?)
        .item(&item("delete-branch", "删除分支…", None)?)
        .separator()
        .item(&item("stash-all-changes", "贮藏全部改动", None)?)
        .item(&item("undo-commit", "撤销上次提交", None)?)
        .build()?;

    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &repository, &branch]).build()
}

/// 把点击转成事件发给前端。做什么由前端决定，菜单不持有业务逻辑。
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Err(e) = app.emit(EVENT, id) {
        log::warn!("菜单事件 {id} 发送失败: {e}");
    }
}
