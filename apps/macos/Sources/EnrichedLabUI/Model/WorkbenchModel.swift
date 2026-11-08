import EnrichedLabKit
import Foundation
import Observation

/// What a workbench tab shows.
public enum Pane: Hashable, Codable, Sendable {
	case files
	/// Every step the session took, with its input, output, files and reason.
	case timeline
	case terminal(id: String)
	/// An agent-made document (HTML, Markdown, SVG, image) the engine serves.
	case view(canvas: String)
	case table(canvas: String)
	case plot(canvas: String)
	/// A running app's page (a Shiny or Streamlit app, a dev server).
	case page(url: String)
	case app(id: String)
	/// The window's own browser.
	case browser
	/// A lab sandbox's browser, shown live.
	case screen(site: String)
	case desktop(site: String)

	/// Panes that are one per session: opening again brings the open one forward.
	var single: Bool {
		switch self {
		case .files, .timeline, .browser, .screen, .desktop: true
		default: false
		}
	}

	var symbol: String {
		switch self {
		case .files: "folder"
		case .timeline: "list.bullet.rectangle"
		case .terminal: "terminal"
		case .view: "doc.richtext"
		case .table: "tablecells"
		case .plot: "chart.xyaxis.line"
		case .page, .app: "app.dashed"
		case .browser: "safari"
		case .screen: "globe"
		case .desktop: "display"
		}
	}
}

public struct WorkbenchTab: Identifiable, Codable, Hashable, Sendable {
	public var id: String
	public var pane: Pane
	public var title: String
}

/// The workbench beside a session: its tabs, the one in front, and whether it shows. Kept per session on this Mac.
@MainActor
@Observable
public final class WorkbenchModel {
	let sessionId: String
	public private(set) var tabs: [WorkbenchTab] = []
	public var selected: String?
	public var isOpen = false {
		didSet { if isOpen != oldValue { save() } }
	}

	init(sessionId: String) {
		self.sessionId = sessionId
	}

	public var front: WorkbenchTab? { tabs.first { $0.id == selected } ?? tabs.first }

	static func pane(for view: CanvasSummary) -> Pane {
		switch view.kind {
		case "table": .table(canvas: view.id)
		case "plot": .plot(canvas: view.id)
		case "page": .page(url: view.href ?? view.url)
		default: .view(canvas: view.id)
		}
	}

	/// Open a pane (or bring it forward) and show the workbench.
	@discardableResult
	public func show(_ pane: Pane, title: String, focus: Bool = true) -> String {
		if let open = tabs.first(where: { $0.pane == pane || (pane.single && sameKind($0.pane, pane)) }) {
			if pane.single, open.pane != pane, let i = tabs.firstIndex(of: open) {
				tabs[i].pane = pane
				tabs[i].title = title
			}
			if focus || !isOpen { selected = open.id }
			isOpen = true
			save()
			return open.id
		}
		let tab = WorkbenchTab(id: "t\(UUID().uuidString.prefix(8).lowercased())", pane: pane, title: title)
		tabs.append(tab)
		if focus || selected == nil { selected = tab.id }
		isOpen = true
		save()
		return tab.id
	}

	/// A sandbox browser is one per session whatever its lab; a desktop is one per lab.
	private func sameKind(_ a: Pane, _ b: Pane) -> Bool {
		switch (a, b) {
		case (.files, .files), (.timeline, .timeline), (.browser, .browser), (.screen, .screen): true
		case let (.desktop(x), .desktop(y)): x == y
		default: false
		}
	}

	public func newTerminal() {
		show(.terminal(id: UUID().uuidString), title: "Terminal")
	}

	public func close(_ id: String) {
		guard let i = tabs.firstIndex(where: { $0.id == id }) else { return }
		tabs.remove(at: i)
		if selected == id { selected = tabs.indices.contains(i) ? tabs[i].id : tabs.last?.id }
		if tabs.isEmpty { isOpen = false }
		save()
	}

	public func move(from source: IndexSet, to destination: Int) {
		tabs.move(fromOffsets: source, toOffset: destination)
		save()
	}

	func retitle(_ pane: Pane, title: String) {
		for i in tabs.indices where tabs[i].pane == pane { tabs[i].title = title }
	}

	private var key: String { "workbench.\(sessionId)" }

	private struct Saved: Codable {
		var tabs: [WorkbenchTab]
		var selected: String?
		var open: Bool
	}

	func restore(views: [CanvasSummary]) {
		let known = Set(views.map(\.id))
		if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
			// Views the engine no longer has are dropped; terminals start fresh (their processes ended with the window).
			tabs = saved.tabs.filter { tab in
				switch tab.pane {
				case let .view(id), let .table(id), let .plot(id): known.contains(id)
				default: true
				}
			}
			selected = saved.selected
			isOpen = saved.open && !tabs.isEmpty
		} else {
			// A session with views and no saved tabs opens them, newest in front.
			for view in views.prefix(8).reversed() { tabs.append(WorkbenchTab(id: "t\(UUID().uuidString.prefix(8).lowercased())", pane: Self.pane(for: view), title: view.title)) }
			selected = tabs.last?.id
			isOpen = false
		}
	}

	func save() {
		let saved = Saved(tabs: tabs, selected: selected, open: isOpen)
		if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: key) }
	}
}
