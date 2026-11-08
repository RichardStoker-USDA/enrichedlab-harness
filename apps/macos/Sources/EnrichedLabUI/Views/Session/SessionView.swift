import EnrichedLabKit
import SwiftUI

/// One session: the run sheet, the composer under it, and the workbench beside it.
struct SessionView: View {
	@Environment(AppModel.self) private var app
	@AppStorage("advanced") private var advanced = false
	var session: SessionModel

	var body: some View {
		@Bindable var workbench = session.workbench
		TranscriptView(session: session)
			.safeAreaInset(edge: .bottom, spacing: 0) {
				ComposerArea(session: session)
			}
			.overlay(alignment: .top) {
				// The place's marker: a thin line across the top of the run sheet, in the lab's color.
				if !session.place.isLocal {
					Theme.place(session.place.index).frame(height: 2).accessibilityHidden(true)
				}
			}
			.navigationTitle(session.summary.title.isEmpty ? "New session" : session.summary.title)
			.navigationSubtitle(subtitle)
			.toolbar { toolbar }
			// Opening it in a narrow window widens the window when the screen has room (the macOS behavior).
			// Shown once the window has made room for it (wider, or the sidebar aside), never squeezed in.
			.inspector(isPresented: Binding(get: { workbench.isOpen && app.workbenchRoom }, set: { workbench.isOpen = $0 })) {
				WorkbenchView(session: session)
					.inspectorColumnWidth(min: AppModel.workbenchNarrowest, ideal: min(560, app.workbenchMax), max: app.workbenchMax)
			}
			.focusedSceneValue(\.session, session)
	}

	private var subtitle: String {
		var parts = [session.place.runsLabel]
		if session.summary.parent != nil { parts = ["Subagent"] + parts }
		if let discovery = session.summary.discovery, discovery == session.place.id { parts.append("Discovery") }
		if let moving = session.moving { parts = ["Moving to \(app.place(of: moving).title)…"] }
		return parts.joined(separator: " · ")
	}

	@ToolbarContentBuilder private var toolbar: some ToolbarContent {
		ToolbarItem(placement: .primaryAction) {
			Menu {
				Button("Rename…") { app.renaming = session.id }
				Menu("Move To") {
					ForEach(app.places) { place in
						Button {
							Task { await session.requestMove(to: place) }
						} label: {
							Text(place.isLocal ? place.title : "\(place.title) sandbox")
						}
						.disabled(place.id == session.place.id || (!place.ready && !place.isLocal))
					}
				}
				Divider()
				Button("Undo Last Changes") { Task { await session.undo() } }
					.disabled(session.status?.undoable?.isEmpty ?? true)
				Button("Summarize Older Turns") { Task { await session.compact() } }
					.disabled(session.busy)
				Button("Export Run Package…") { Task { await session.exportPackage() } }
					.disabled(session.busy)
				Divider()
				Button("Show in Finder") { revealInFinder(session.summary.cwd) }
				Button("Copy Folder Path") { copyText(session.summary.cwd, what: "the folder path", app: app) }
				Divider()
				Button("Delete…", role: .destructive) { app.confirmDelete(session.id) }
					.disabled(session.busy)
			} label: {
				Label("Session", systemImage: "ellipsis.circle")
			}
			.help("Session actions")
		}
		ToolbarItem(placement: .primaryAction) {
			Button {
				withAnimation(.smooth(duration: 0.25)) { session.workbench.isOpen.toggle() }
			} label: {
				Label("Workbench", systemImage: "sidebar.trailing")
			}
			.help(session.workbench.isOpen ? "Hide the workbench (⌥⌘B)" : "Show the workbench (⌥⌘B)")
		}
	}
}

// MARK: Focused values (menu commands act on the window's session)

struct SessionKey: FocusedValueKey {
	typealias Value = SessionModel
}

extension FocusedValues {
	var session: SessionModel? {
		get { self[SessionKey.self] }
		set { self[SessionKey.self] = newValue }
	}
}
