import EnrichedLabKit
import SwiftUI

/// The menu bar: every command with its shortcut, acting on the window's session.
public struct EnrichedLabCommands: Commands {
	let app: AppModel
	@FocusedValue(\.session) private var session
	@Environment(\.openSettings) private var openSettings
	@AppStorage("advanced") private var advanced = false

	public init(app: AppModel) {
		self.app = app
	}

	public var body: some Commands {
		CommandGroup(after: .appInfo) {
			Button("Check for Updates…") {
				app.showSettingsTab = .updates
				openSettings()
			}
		}
		CommandGroup(replacing: .newItem) {
			Button("New Session") { app.beginNew() }
				.keyboardShortcut("n")
			Button("Add a Lab…") { app.joining = JoinRequest() }
				.keyboardShortcut("l", modifiers: [.command, .shift])
		}
		CommandMenu("Session") {
			Button("Stop") { if let session { Task { await session.stop() } } }
				.keyboardShortcut(".")
				.disabled(session?.busy != true)
			Divider()
			Button("Rename…") { if let session { app.renaming = session.id } }
				.disabled(session == nil)
			Menu("Move To") {
				ForEach(app.places) { place in
					Button(place.isLocal ? place.title : "\(place.title) Sandbox") {
						if let session { Task { await session.requestMove(to: place) } }
					}
					.disabled(session == nil || session?.place.id == place.id)
				}
			}
			.disabled(session == nil || session?.busy == true)
			Divider()
			Button("Undo Last Changes") { if let session { Task { await session.undo() } } }
				.keyboardShortcut("z", modifiers: [.command, .option])
				.disabled(session?.status?.undoable?.isEmpty ?? true)
			Button("Summarize Older Turns") { if let session { Task { await session.compact() } } }
				.disabled(session == nil || session?.busy == true)
			Divider()
			Button("Show in Finder") { if let session { revealInFinder(session.summary.cwd) } }
				.keyboardShortcut("r", modifiers: [.command, .shift])
				.disabled(session == nil)
			Divider()
			Button("Delete…") { if let session { app.confirmDelete(session.id) } }
				.disabled(session == nil || session?.busy == true)
		}
		CommandGroup(after: .sidebar) {
			Button(session?.workbench.isOpen == true ? "Hide Workbench" : "Show Workbench") {
				withAnimation(.smooth(duration: 0.25)) { session?.workbench.isOpen.toggle() }
			}
			.keyboardShortcut("b", modifiers: [.command, .option])
			.disabled(session == nil)
			Button("New Terminal") { session?.workbench.newTerminal() }
				.keyboardShortcut("`", modifiers: [.control])
				.disabled(session == nil)
			Button("Files") { session?.workbench.show(.files, title: "Files") }
				.keyboardShortcut("f", modifiers: [.command, .option])
				.disabled(session == nil)
			Button("Timeline") { session?.workbench.show(.timeline, title: "Timeline") }
				.keyboardShortcut("t", modifiers: [.command, .option])
				.disabled(session == nil)
			Button("Browser") { session?.workbench.show(.browser, title: "Browser") }
				.disabled(session == nil)
			Divider()
			Picker("Appearance", selection: Binding(get: { app.ui.theme }, set: { theme in Task { await app.setTheme(theme) } })) {
				Text("System").tag("auto")
				Text("Light").tag("light")
				Text("Dark").tag("dark")
			}
			Toggle("Show the Agent's Thinking", isOn: Binding(get: { app.ui.showReasoning }, set: { on in Task { await app.setShowReasoning(on) } }))
			Toggle("Show Advanced Controls", isOn: $advanced)
			Divider()
		}
		CommandGroup(replacing: .help) {
			Button("EnrichedLab Help") {
				if let url = URL(string: "https://github.com/RichardStoker-USDA/enrichedlab-harness#readme") { NSWorkspace.shared.open(url) }
			}
		}
	}
}
