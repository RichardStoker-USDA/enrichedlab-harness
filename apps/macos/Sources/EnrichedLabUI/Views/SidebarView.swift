import EnrichedLabKit
import SwiftUI

/// Places (this Mac and each lab) and the sessions, grouped by project. Search covers all history.
struct SidebarView: View {
	@Environment(AppModel.self) private var app
	@State private var query = ""
	@State private var found: [SessionSummary] = []
	@State private var searchError: String?
	@State private var expanded: Set<String> = []

	var body: some View {
		@Bindable var app = app
		List(selection: $app.selection) {
			if query.isEmpty {
				Section("Places") {
					ForEach(app.places) { place in PlaceRow(place: place) }
				}
				ForEach(app.projects, id: \.folder) { project in
					Section {
						let shown = expanded.contains(project.folder) ? project.sessions : Array(project.sessions.prefix(6))
						ForEach(shown) { session in SessionRow(session: session).tag(session.id) }
						if project.sessions.count > 6, !expanded.contains(project.folder) {
							Button("Show \(project.sessions.count - 6) More") { expanded.insert(project.folder) }
								.buttonStyle(.borderless)
								.foregroundStyle(.secondary)
								.font(.callout)
						}
					} header: {
						ProjectHeader(folder: project.folder)
					}
				}
				if app.sessions.count >= app.sessionLimit {
					Button("Show Older Sessions") { Task { await app.loadOlderSessions() } }
						.buttonStyle(.borderless)
						.foregroundStyle(.secondary)
				}
			} else {
				Section(found.isEmpty ? (searchError ?? "No sessions match") : "Sessions") {
					ForEach(found) { session in SessionRow(session: session, showFolder: true).tag(session.id) }
				}
			}
		}
		.listStyle(.sidebar)
		.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if $0 > 0 { app.sidebarWidth = $0 } }
		.searchable(text: $query, placement: .sidebar, prompt: "Search sessions")
		.task(id: query) { await search() }
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				Button {
					app.beginNew()
				} label: {
					Label("New Session", systemImage: "square.and.pencil")
				}
				.help("New Session (⌘N)")
			}
		}
		.overlay {
			if app.sessions.isEmpty, app.connected, query.isEmpty {
				ContentUnavailableView {
					Label("No Sessions Yet", systemImage: "text.bubble")
				} description: {
					Text("Your sessions appear here, grouped by project.")
				}
				.padding(.top, 160)
			}
		}
	}

	private func search() async {
		let words = query.trimmingCharacters(in: .whitespaces)
		guard !words.isEmpty else { found = []; return }
		try? await Task.sleep(for: .milliseconds(180))
		guard !Task.isCancelled else { return }
		// What the sidebar holds matches at once; the engine searches older history.
		let lower = words.lowercased()
		found = app.sessions.filter { $0.title.lowercased().contains(lower) || $0.cwd.lowercased().contains(lower) }
		do {
			let older = try await app.connection.sessions(limit: 40, query: words)
			let known = Set(found.map(\.id))
			found += older.filter { !known.contains($0.id) }
			searchError = nil
		} catch {
			searchError = "Search didn't run: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)"
		}
	}
}

/// A place: this Mac or a lab, its state in words, and its actions.
private struct PlaceRow: View {
	@Environment(AppModel.self) private var app
	var place: Place
	@State private var busy = false
	@State private var explaining = false

	var body: some View {
		Button {
			Task { await primary() }
		} label: {
			HStack(spacing: 9) {
				PlaceDot(place: place, size: 8)
				VStack(alignment: .leading, spacing: 1) {
					Text(place.title).lineLimit(1)
					Text(place.detail).font(.caption).foregroundStyle(statusStyle).lineLimit(1)
				}
				Spacer(minLength: 4)
				if busy { ProgressView().controlSize(.mini) }
				else if app.session?.place.id == place.id {
					Text("This session").font(.caption2).foregroundStyle(.secondary)
				}
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.help(help)
		.contextMenu { menu }
		.accessibilityLabel("\(place.title), \(place.detail)")
		.popover(isPresented: $explaining, arrowEdge: .trailing) { LocalSandboxNote() }
	}

	private var statusStyle: some ShapeStyle {
		if let site = place.site, site.error != nil, !site.signedIn { return AnyShapeStyle(Theme.bad) }
		return AnyShapeStyle(.secondary)
	}

	private var help: String {
		if let site = place.site, !site.signedIn { return "Sign in to \(place.title)" }
		return place.isLocal ? "New session on this Mac, in its local sandbox: commands change only the project and temp folders, without the network or your credential folders" : "New session in the \(place.title) sandbox"
	}

	private func primary() async {
		if let site = place.site, !site.signedIn {
			busy = true
			_ = await app.signIn(site.name)
			busy = false
		} else {
			app.beginNew(place: place.id)
		}
	}

	@ViewBuilder private var menu: some View {
		Button(place.isLocal ? "New Session on This Mac" : "New Session in \(place.title)") { app.beginNew(place: place.id) }
			.disabled(!place.ready && !place.isLocal)
		if place.isLocal { Button("About the Local Sandbox") { explaining = true } }
		if let site = place.site {
			Divider()
			if site.signedIn {
				Button("Reconnect") { Task { await app.reconnectLabs() } }
				Button("Sign Out") { Task { await app.signOut(site.name) } }
			} else {
				Button("Sign In…") { Task { await app.signIn(site.name) } }
			}
			if let docs = site.docs.flatMap(URL.init(string:)) { Button("\(place.title) Docs") { NSWorkspace.shared.open(docs) } }
			if let support = site.support.flatMap(URL.init(string:)) { Button("Get Help from \(place.title)") { NSWorkspace.shared.open(support) } }
			Divider()
			Button("Remove \(place.title)…", role: .destructive) { app.confirmRemoveLab(site.name) }
		} else {
			Divider()
			Button("Add a Lab…") { app.joining = JoinRequest() }
		}
	}
}

/// A project's header: its folder name, with the full path on hover and its actions.
private struct ProjectHeader: View {
	@Environment(AppModel.self) private var app
	var folder: String

	var body: some View {
		Text(folderName(folder))
			.help(shortPath(folder))
			.contextMenu {
				Button("New Session in \(folderName(folder))") { app.beginNew(place: "local", folder: URL(fileURLWithPath: folder)) }
				Button("Show in Finder") { revealInFinder(folder) }
				Button("Copy Path") { copyText(folder, what: "the folder path", app: app) }
			}
	}
}

/// A session: its title, when it last changed (or that it's running), and where it runs when that's a lab.
struct SessionRow: View {
	@Environment(AppModel.self) private var app
	var session: SessionSummary
	var showFolder = false
	@State private var title = ""
	@FocusState private var editing: Bool

	var body: some View {
		HStack(spacing: 6) {
			VStack(alignment: .leading, spacing: 1) {
				if app.renaming == session.id {
					TextField("Title", text: $title)
						.textFieldStyle(.plain)
						.focused($editing)
						.onSubmit { Task { await commit() } }
						.onExitCommand { app.renaming = nil }
						.onAppear {
							title = session.title
							editing = true
						}
						.onChange(of: editing) { _, now in if !now, app.renaming == session.id { Task { await commit() } } }
				} else {
					Text(session.title.isEmpty ? "New session" : session.title).lineLimit(1)
				}
				if showFolder || placeTitle != nil {
					Text([showFolder ? folderName(projectFolder(session.cwd)) : nil, placeTitle].compactMap { $0 }.joined(separator: " · "))
						.font(.caption)
						.foregroundStyle(.secondary)
						.lineLimit(1)
				}
			}
			Spacer(minLength: 4)
			if session.running {
				Text("Running").font(.caption2.weight(.medium)).foregroundStyle(Theme.accent)
			} else {
				Text(ago(session.updated)).font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
			}
		}
		.contextMenu {
			Button("Rename…") { app.renaming = session.id }
			Button("Show in Finder") { revealInFinder(session.cwd) }
			Button("Copy Folder Path") { copyText(session.cwd, what: "the folder path", app: app) }
			Divider()
			Button("Delete…", role: .destructive) { app.confirmDelete(session.id) }
				.disabled(session.running)
		}
		.accessibilityElement(children: .combine)
	}

	private var placeTitle: String? {
		guard let place = session.place, place != "local" else { return nil }
		return app.place(of: place).title
	}

	private func commit() async {
		let wanted = title
		app.renaming = nil
		if wanted != session.title { _ = await app.rename(session.id, to: wanted) }
	}
}

/// What "local sandbox" means, in the person's terms (docs/security.md, "The local sandbox").
private struct LocalSandboxNote: View {
	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Text("The local sandbox").font(.headline)
			Text("On this Mac, the agent's commands run inside a sandbox macOS enforces. No administrator setup.")
				.foregroundStyle(.secondary)
			VStack(alignment: .leading, spacing: 6) {
				fact("Changes", "Only the project folder and temporary folders.")
				fact("Network", "Off, unless you allow a command to use it.")
				fact("Private folders", "~/.ssh, key stores and browser profiles stay hidden; keys and tokens are left out of its environment.")
				fact("Packages", "Each project gets its own environment (pixi, in the project's .pixi folder), kept apart from the system and other projects.")
				fact("Going back", "Every step is kept, so changes in the project can be taken back.")
			}
			Text("It can still read files elsewhere that aren't hidden. A command you approve to run outside the sandbox can do anything you can.")
				.font(.caption)
				.foregroundStyle(.secondary)
		}
		.padding(16)
		.frame(width: 340, alignment: .leading)
	}

	private func fact(_ label: String, _ text: String) -> some View {
		VStack(alignment: .leading, spacing: 1) {
			Text(label).font(.caption.weight(.semibold))
			Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
		}
	}
}
