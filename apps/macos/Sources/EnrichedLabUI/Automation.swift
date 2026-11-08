#if DEBUG
import AppKit
import EnrichedLabKit
import SwiftUI

/// Scenes for scripts/dev_lab.ts --mac: put the window in a known state from the environment, then print the window
/// numbers so the script can capture this app's windows (and only them). Debug builds only.
///
/// EL_SCENE_SESSION  a session id to open
/// EL_SCENE_PANE     files, terminal, browser, desktop, or first (the newest view)
/// EL_SCENE_SETTINGS general, models, labs or updates: open Settings on that tab
/// EL_SCENE_SIZE     the window's content size, such as 1360x880
/// EL_SCENE_RESIZE   a content size applied after the pane opens (narrowing a window with the workbench open)
/// EL_SCENE_ADVANCED 1 to show advanced controls
/// EL_SCENE_AFTER    milliseconds to wait before saying the scene is ready
/// EL_SCENE_PROMPT   start a new session in the newest project with this task, as the New Session view does
/// EL_SCENE_UNTIL    streaming (a long tool call is arriving), question (it asks), or done (allowed, then finished)
/// EL_SCENE_OPEN     a file in the session's folder to open as a view (a dashboard, say)
/// EL_SCENE_DRAG     window or divider: drag the window's edge, or the workbench's divider, in small steps as a person would
/// EL_SCENE_SEND     a message sent in the opened session; the scene waits for its first question
/// EL_SCENE_FOLDER   a folder to ask about, as the first session there does (the question stays open)
/// EL_SCENE_SCROLLUP 1 to scroll the run sheet up 800 points partway through a live turn, as a reader looking back does
@MainActor
enum Automation {
	static var active: Bool { ProcessInfo.processInfo.environment["EL_SCENE"] != nil }

	static func run(app: AppModel, openSettings: OpenSettingsAction) async {
		let env = ProcessInfo.processInfo.environment
		guard env["EL_SCENE"] != nil else { return }
		UserDefaults.standard.set(env["EL_SCENE_ADVANCED"] == "1", forKey: "advanced")
		for _ in 0 ..< 100 where !app.connected { try? await Task.sleep(for: .milliseconds(100)) }

		// The size comes first: opening the workbench in a narrow window then widens it, as macOS does.
		if let size = env["EL_SCENE_SIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2, let window = mainWindow {
			window.setContentSize(NSSize(width: size[0], height: size[1]))
			window.center()
		}
		if let folder = env["EL_SCENE_FOLDER"] {
			Task { _ = await app.askFolder(URL(fileURLWithPath: folder)) }
			try? await Task.sleep(for: .milliseconds(600))
		}
		if let prompt = env["EL_SCENE_PROMPT"] { await live(app: app, prompt: prompt, until: env["EL_SCENE_UNTIL"] ?? "done") }
		if let id = env["EL_SCENE_SESSION"] {
			app.selection = id
			for _ in 0 ..< 100 where app.session?.id != id || app.session?.opening == true { try? await Task.sleep(for: .milliseconds(100)) }
		}
		if let pane = env["EL_SCENE_PANE"], let session = app.session {
			switch pane {
			case "files": session.workbench.show(.files, title: "Files")
			case "terminal": session.workbench.newTerminal()
			case "browser": session.workbench.show(.browser, title: "Browser")
			case "desktop": if let site = session.place.site { session.workbench.show(.desktop(site: site.name), title: "\(session.place.title) desktop") }
			case "first":
				// The session's views arrive after it opens.
				for _ in 0 ..< 50 where session.canvases.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
				if let view = session.canvases.first { session.showView(view.id) }
			default: break
			}
		}
		if let text = env["EL_SCENE_SEND"], let session = app.session {
			_ = await session.send(text)
			for _ in 0 ..< 300 where session.pending.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
			print("scene: sent; \(session.pending.count) question(s): \(session.pending.first?.reason ?? "none")")
		}
		if let path = env["EL_SCENE_OPEN"], let session = app.session {
			await session.openFile(path.hasPrefix("/") ? path : "\(session.summary.cwd)/\(path)")
		}
		if let how = env["EL_SCENE_DRAG"], let window = mainWindow {
			// The page loads and lays out first, as it would before a person reaches for the edge.
			try? await Task.sleep(for: .milliseconds(1500))
			let steps = await drag(how, window: window, app: app)
			print("scene: dragged the \(how) through \(steps) steps, ending \(Int(window.contentLayoutRect.width)) wide (smallest \(Int(window.contentMinSize.width)))")
		}
		if let size = env["EL_SCENE_RESIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2, let window = mainWindow {
			try? await Task.sleep(for: .milliseconds(800))
			// As far as a person dragging the window's edge could take it.
			let smallest = window.contentMinSize
			window.setContentSize(NSSize(width: max(size[0], smallest.width), height: max(size[1], smallest.height)))
			print("scene: narrowed to \(Int(window.contentLayoutRect.width)) (smallest \(Int(smallest.width)))")
		}
		if let tab = env["EL_SCENE_SETTINGS"].flatMap(SettingsTab.init(rawValue:)) {
			app.showSettingsTab = tab
			openSettings()
		}
		try? await Task.sleep(for: .milliseconds(Double(env["EL_SCENE_AFTER"] ?? "1500") ?? 1500))
		for window in NSApp.windows where window.isVisible && window.frame.width > 200 {
			print("scene: window \(window.windowNumber) \(window.identifier?.rawValue ?? window.title)")
		}
		print("scene: ready")
		fflush(stdout)
	}

	/// Wider to the screen's edge and back to the window's smallest width, 6 points at a time with a display cycle
	/// between, or the workbench's divider 500 points left and back: what a person's drag does. A script can't enter
	/// AppKit's live resize (inLiveResize stays false), so the window drag checks each size, not the end of a drag; the
	/// divider drag is the one that brought back the November 7 crash on the old code.
	private static func drag(_ how: String, window: NSWindow, app: AppModel) async -> Int {
		var steps = 0
		func turn() async {
			steps += 1
			try? await Task.sleep(for: .milliseconds(12))
		}
		if how == "divider" {
			// The innermost split view holds the run sheet and the workbench.
			guard let split = splitViews(in: window.contentView).last(where: { $0.arrangedSubviews.count >= 2 }) else { return 0 }
			let index = split.arrangedSubviews.count - 2
			// The workbench's left edge (the run sheet can reach under it, so its own right edge isn't the divider).
			let start = split.arrangedSubviews[index + 1].frame.minX
			let widths = { split.arrangedSubviews.map { Int($0.frame.width) } }
			print("scene: divider \(index) of \(widths()) at \(Int(start)), workbench open \(app.session?.workbench.isOpen ?? false), room \(app.workbenchRoom)")
			for x in stride(from: start, through: max(300, start - 500), by: -6) { split.setPosition(x, ofDividerAt: index); await turn() }
			print("scene: divider moved: \(widths()), workbench open \(app.session?.workbench.isOpen ?? false), room \(app.workbenchRoom)")
			for x in stride(from: max(300, start - 500), through: start, by: 6) { split.setPosition(x, ofDividerAt: index); await turn() }
			print("scene: divider back: \(widths()), workbench open \(app.session?.workbench.isOpen ?? false), room \(app.workbenchRoom)")
			return steps
		}
		let screen = window.screen?.visibleFrame.width ?? 1600
		let height = window.contentLayoutRect.height
		let from = window.contentLayoutRect.width
		for width in stride(from: from, through: screen - 20, by: 6) { window.setContentSize(NSSize(width: width, height: height)); await turn() }
		for width in stride(from: screen - 20, through: window.contentMinSize.width, by: -6) { window.setContentSize(NSSize(width: width, height: height)); await turn() }
		return steps
	}

	/// The run sheet's scroll view: the tallest one.
	private static func transcriptScroll(_ window: NSWindow) -> NSScrollView? {
		func scrolls(_ view: NSView) -> [NSScrollView] { ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrolls) }
		return window.contentView.flatMap { scrolls($0).max(by: { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }) }
	}

	/// The run sheet's distance from its bottom.
	private static func transcriptGap(_ window: NSWindow) -> CGFloat? {
		guard let scroll = transcriptScroll(window), let document = scroll.documentView else { return nil }
		let visible = scroll.contentView.bounds
		// The composer sits over the bottom as an inset: the bottom is reached when the inset's edge meets the content's.
		return document.isFlipped ? document.frame.height - visible.maxY + scroll.contentInsets.bottom : visible.minY
	}

	private static func splitViews(in view: NSView?) -> [NSSplitView] {
		guard let view else { return [] }
		let own: [NSSplitView] = (view as? NSSplitView).map { [$0] } ?? []
		return own + view.subviews.flatMap { splitViews(in: $0) }
	}

	private static var mainWindow: NSWindow? {
		NSApp.windows.first { $0.isVisible && $0.frame.width > 400 && !$0.title.contains("Settings") }
	}

	/// A live turn from the window, measured: how soon output appears, and the longest the main thread was busy.
	private static func live(app: AppModel, prompt: String, until: String) async {
		guard let folder = app.projects.first?.folder else { print("scene: live: no project"); return }
		// The longest the main thread was busy, before the first output (opening the session) and after (streaming).
		var opening: Duration = .zero
		var streaming: Duration = .zero
		var first: Duration?
		var watching = true
		let clock = ContinuousClock()
		let watch = Task { @MainActor in
			while watching {
				let start = clock.now
				try? await Task.sleep(for: .milliseconds(10))
				let stall = clock.now - start - .milliseconds(10)
				if first == nil { opening = max(opening, stall) } else { streaming = max(streaming, stall) }
			}
		}
		// The first session in a folder asks about it: a live scene lets the agent change files there.
		let answering = Task { @MainActor in
			while !Task.isCancelled {
				app.folderQuestion?.respond(.change)
				try? await Task.sleep(for: .milliseconds(50))
			}
		}
		defer { answering.cancel() }
		let sent = clock.now
		guard await app.create(folder: URL(fileURLWithPath: folder), place: "local", model: nil, prompt: prompt) != nil else { print("scene: live: not started"); return }
		var answered = false
		var scrolledUp = ProcessInfo.processInfo.environment["EL_SCENE_SCROLLUP"] != "1"
		for _ in 0 ..< 600 {
			if !scrolledUp, (app.session?.blocks.count ?? 0) > 12, let window = mainWindow, let scroll = transcriptScroll(window) {
				scrolledUp = true
				// Wheel events, the path a mouse or trackpad takes, not a jump of the clip view.
				for _ in 0 ..< 10 {
					if let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 80, wheel2: 0, wheel3: 0), let event = NSEvent(cgEvent: wheel) {
						scroll.scrollWheel(with: event)
					}
					try? await Task.sleep(for: .milliseconds(16))
				}
				print("scene: scrolled up 800 pt mid-turn, \(Int(transcriptGap(window) ?? -1)) pt from the bottom")
			}
			guard let session = app.session else { break }
			if first == nil, !session.partial.text.isEmpty || !session.partial.tools.isEmpty || !session.blocks.isEmpty { first = clock.now - sent }
			if until == "streaming", (session.partial.tools.first?.args.count ?? 0) > 4000 { break }
			if until == "question", !session.pending.isEmpty { break }
			if until == "done" {
				if let question = session.pending.first, !answered {
					answered = true
					await session.answer(question, .allow)
				}
				if answered, !session.busy { break }
			}
			try? await Task.sleep(for: .milliseconds(100))
		}
		watching = false
		_ = await watch.value
		let ms = { (d: Duration?) in d.map { String(Int($0.components.seconds * 1000 + $0.components.attoseconds / 1_000_000_000_000_000)) } ?? "none" }
		let session = app.session
		// How far the run sheet is from its bottom: a session that followed its output ends at the bottom.
		let gap = mainWindow.flatMap { transcriptGap($0) }.map { "\(Int($0)) pt" } ?? "unknown"
		print("scene: live \(until): transcript \(gap) from the bottom; first output \(ms(first)) ms, longest main-thread stall opening \(ms(opening)) ms, streaming \(ms(streaming)) ms, steps \(session?.blocks.count ?? 0), questions \(session?.pending.count ?? 0), busy \(session?.busy ?? false)")
	}
}
#endif
