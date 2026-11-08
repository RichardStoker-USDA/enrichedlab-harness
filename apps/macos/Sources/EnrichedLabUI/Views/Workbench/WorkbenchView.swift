import EnrichedLabKit
import SwiftUI

/// The workbench beside the session: tabs across the top, the front one below. Results are used here as well as
/// seen: files, a terminal, the browser, tables, plots, apps, views and a lab's desktop.
struct WorkbenchView: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		VStack(spacing: 0) {
			TabStrip(session: session)
				.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if $0 > 0 { app.workbenchWidth = $0 } }
			Divider()
			ZStack {
				if let tab = session.workbench.front {
					PaneView(tab: tab, session: session)
						.id(tab.id)
				} else {
					ContentUnavailableView {
						Label("Nothing Open", systemImage: "rectangle.split.2x1")
					} description: {
						Text("Tables, plots, apps and pages the agent makes open here. You can also open the project's files, a terminal or a browser.")
					} actions: {
						HStack {
							Button("Files") { session.workbench.show(.files, title: "Files") }
							Button("Terminal") { session.workbench.newTerminal() }
							Button("Browser") { session.workbench.show(.browser, title: "Browser") }
						}
					}
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
		}
		// One step off the canvas: a blue-white beside the white run sheet, black 90 beside the black one.
		.background(Theme.surface)
	}
}

/// The tabs: click to bring forward, close on hover or with ⌘W, and a menu to open more.
private struct TabStrip: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		HStack(spacing: 2) {
			ScrollView(.horizontal) {
				HStack(spacing: 2) {
					ForEach(session.workbench.tabs) { tab in
						TabButton(tab: tab, selected: tab.id == session.workbench.front?.id, session: session)
					}
				}
				.padding(.horizontal, 6)
			}
			.scrollIndicators(.never)
			Spacer(minLength: 0)
			OpenMenu(session: session)
				.padding(.trailing, 8)
		}
		.frame(height: 34)
	}
}

private struct TabButton: View {
	@Environment(AppModel.self) private var app
	var tab: WorkbenchTab
	var selected: Bool
	var session: SessionModel
	@State private var hovering = false

	var body: some View {
		HStack(spacing: 6) {
			Image(systemName: tab.pane.symbol).font(.caption).foregroundStyle(selected ? Theme.accent : .secondary)
			Text(tab.title).lineLimit(1).font(.callout).foregroundStyle(selected ? .primary : .secondary)
			Button {
				close()
			} label: {
				Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
			}
			.buttonStyle(.plain)
			.foregroundStyle(.secondary)
			.opacity(hovering || selected ? 1 : 0)
			.accessibilityLabel("Close \(tab.title)")
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 5)
		.background(selected ? AnyShapeStyle(Theme.selected) : AnyShapeStyle(Color.clear), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
		.contentShape(Rectangle())
		.onTapGesture { session.workbench.selected = tab.id }
		.onHover { hovering = $0 }
		.contextMenu {
			Button("Close Tab") { close() }
			if case .terminal = tab.pane { Button("New Terminal") { session.workbench.newTerminal() } }
		}
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
	}

	private func close() {
		if case let .terminal(id) = tab.pane { app.terminalHub.close(paneId: id) }
		session.workbench.close(tab.id)
	}
}

/// Open something in the workbench.
private struct OpenMenu: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		Menu {
			Button("Files") { session.workbench.show(.files, title: "Files") }
			Button("New Terminal") { session.workbench.newTerminal() }
			Button("Browser") { session.workbench.show(.browser, title: "Browser") }
			if let site = session.place.site, site.desktop != nil {
				Button("\(session.place.title) Desktop") { session.workbench.show(.desktop(site: site.name), title: "\(session.place.title) desktop") }
			}
			if !session.canvases.isEmpty {
				Section("Views") {
					ForEach(session.canvases.prefix(12)) { view in Button(view.title) { session.showView(view.id) } }
				}
			}
			if !app.apps.isEmpty || !app.labOffers.isEmpty {
				Section("Apps") {
					ForEach(app.apps) { item in Button(item.title) { session.workbench.show(.app(id: item.id), title: item.title) } }
					ForEach(app.labOffers, id: \.name) { offer in
						Button("Install \(offer.title) from \(offer.lab)") { Task { await install(offer) } }
					}
				}
			}
		} label: {
			Image(systemName: "plus")
		}
		.menuStyle(.button)
		.buttonStyle(.borderless)
		.menuIndicator(.hidden)
		.fixedSize()
		.help("Open in the workbench")
	}

	private func install(_ offer: LabApp) async {
		do {
			let installed = try await app.connection.call("lab.app.install", ["site": offer.site, "name": offer.name, "version": offer.version], as: AppSummary.self)
			await app.refreshApps()
			app.say("Installed \(installed.title) \(installed.version) from \(offer.lab).")
			session.workbench.show(.app(id: installed.id), title: installed.title)
		} catch {
			app.said(error)
		}
	}
}

/// The front tab's pane.
private struct PaneView: View {
	@Environment(AppModel.self) private var app
	var tab: WorkbenchTab
	var session: SessionModel

	var body: some View {
		switch tab.pane {
		case .files:
			FilesPane(session: session)
		case let .terminal(id):
			TerminalPane(paneId: id, session: session)
		case let .view(canvas):
			if let view = session.canvases.first(where: { $0.id == canvas }), let url = URL(string: view.url) {
				WebPane(url: url, title: view.title)
			} else {
				missing
			}
		case let .table(canvas):
			if let view = session.canvases.first(where: { $0.id == canvas }) { TablePane(view: view) } else { missing }
		case let .plot(canvas):
			if let view = session.canvases.first(where: { $0.id == canvas }) { PlotPane(view: view) } else { missing }
		case let .page(url):
			if let url = URL(string: url) { WebPane(url: url, title: tab.title, toolbar: true) } else { missing }
		case let .app(id):
			AppPane(appId: id, session: session)
		case .browser:
			BrowserPane(browser: session.browser)
		case let .screen(site):
			ScreenPane(site: site, session: session)
		case let .desktop(site):
			DesktopPane(site: site, session: session)
		}
	}

	private var missing: some View {
		ContentUnavailableView("This View Is Gone", systemImage: "questionmark.square.dashed", description: Text("The engine no longer has it. Close this tab."))
	}
}
