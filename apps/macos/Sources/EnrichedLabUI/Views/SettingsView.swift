import AppKit
import EnrichedLabKit
import SwiftUI

/// EnrichedLab › Settings (⌘,).
public struct SettingsView: View {
	@Environment(AppModel.self) private var app
	@State private var tab: SettingsTab = .general

	public init() {}

	public var body: some View {
		TabView(selection: $tab) {
			Tab("General", systemImage: "gearshape", value: SettingsTab.general) { GeneralSettings() }
			Tab("Models", systemImage: "cpu", value: SettingsTab.models) { ModelSettings() }
			Tab("Labs", systemImage: "building.columns", value: SettingsTab.labs) { LabSettings() }
			Tab("Updates", systemImage: "arrow.down.circle", value: SettingsTab.updates) { UpdateSettings() }
		}
		.frame(width: 640, height: 520)
		.tint(Theme.accent)
		.onAppear { if let wanted = app.showSettingsTab { tab = wanted; app.showSettingsTab = nil } }
		.onChange(of: app.showSettingsTab) { _, wanted in if let wanted { tab = wanted; app.showSettingsTab = nil } }
	}
}

private struct GeneralSettings: View {
	@Environment(AppModel.self) private var app
	@AppStorage("advanced") private var advanced = false

	var body: some View {
		Form {
			Picker("Appearance", selection: Binding(get: { app.ui.theme }, set: { theme in Task { await app.setTheme(theme) } })) {
				Text("System").tag("auto")
				Text("Light").tag("light")
				Text("Dark").tag("dark")
			}
			.pickerStyle(.segmented)
			Toggle("Show the agent's thinking", isOn: Binding(get: { app.ui.showReasoning }, set: { on in Task { await app.setShowReasoning(on) } }))
			Section {
				Toggle("Show advanced controls", isOn: $advanced)
			} footer: {
				Text("Adds each model's effort setting, the context gauge and speed, full tool output on every step, lab sandboxes and the lab contract check. Everything else works the same.")
					.foregroundStyle(.secondary)
			}
			ApprovalSettings()
			Section("Engine") {
				LabeledContent("Version", value: app.engineVersion ?? "not connected")
				LabeledContent("Data", value: shortPath(app.locator.home.path))
				Button("Show Data Folder in Finder") { revealInFinder(app.locator.home.path) }
			}
		}
		.formStyle(.grouped)
	}
}

/// How much new sessions ask, and the folders EnrichedLab may change or only read.
private struct ApprovalSettings: View {
	@Environment(AppModel.self) private var app
	@State private var folders: [EngineConnection.FolderGrant] = []

	var body: some View {
		Section {
			Picker("New sessions", selection: Binding(get: { app.ui.permissionMode }, set: { mode in Task { await app.setDefaultPermissions(mode) } })) {
				ForEach(PermissionMode.allCases, id: \.self) { mode in
					VStack(alignment: .leading, spacing: 2) {
						Text(mode.title)
						Text(mode.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
					}
					.tag(mode)
				}
			}
			.pickerStyle(.radioGroup)
		} header: {
			Text("Approvals")
		} footer: {
			Text("Each session can change this from the shield menu beside its model.").foregroundStyle(.secondary)
		}
		Section("Folders") {
			if folders.isEmpty {
				Text("EnrichedLab asks about each folder the first time you start a session in it.").foregroundStyle(.secondary)
			}
			ForEach(folders) { folder in
				LabeledContent {
					Picker("Access", selection: Binding(get: { folder.access }, set: { access in Task { await set(folder.path, access.rawValue) } })) {
						Text("Change files").tag(FolderAccess.change)
						Text("Read only").tag(FolderAccess.read)
					}
					.labelsHidden()
					.fixedSize()
					Button("Forget") { Task { await set(folder.path, "none") } }
						.help("Ask again the next time a session starts in this folder")
				} label: {
					Text(shortPath(folder.path)).lineLimit(1).truncationMode(.middle).help(folder.path)
				}
			}
		}
		.task { await load() }
	}

	private func load() async {
		folders = (try? await app.connection.folders()) ?? []
	}

	private func set(_ path: String, _ access: String) async {
		do { _ = try await app.connection.folderAccess(path, set: access) } catch { app.said(error) }
		await load()
	}
}

private struct ModelSettings: View {
	@Environment(AppModel.self) private var app
	@State private var providers: ProviderList?
	@State private var local: LocalModelsStatus?
	@State private var adding: ProviderPreset?
	@State private var key = ""
	@State private var working = false
	@State private var error: String?

	var body: some View {
		Form {
			Section("Default model for new sessions") {
				Picker("Model", selection: Binding(get: { app.defaultModel ?? "" }, set: { ref in Task { try? await app.connection.setDefaultModel(ref); await app.refreshModels() } })) {
					ForEach(modelGroups(app.allowed(site: nil))) { group in
						Section(group.label) { ForEach(group.models) { Text($0.label).tag($0.ref) } }
					}
				}
			}
			Section("ChatGPT plan") {
				if let accounts = providers?.accounts, !accounts.isEmpty {
					ForEach(accounts) { account in
						LabeledContent(account.label) {
							Text(account.signedIn ? (account.active ? "In use" : "Signed in") : "Signed out").foregroundStyle(.secondary)
						}
					}
				}
				Button("Continue with ChatGPT…") {
					Task {
						working = true
						defer { working = false }
						do {
							let result = try await app.connection.chatGPTSignIn()
							app.say("Signed in to ChatGPT as \(result.account.label); \(result.models) models are ready.")
							await reload()
						} catch { app.said(error) }
					}
				}
				.disabled(working)
			}
			Section {
				ForEach(providers?.added ?? []) { added in
					LabeledContent(added.label) {
						Button("Remove", role: .destructive) { Task { try? await app.connection.removeProvider(added.name); await reload(); await app.refreshModels() } }
					}
				}
				Menu("Add a Key") {
					ForEach(providers?.presets ?? []) { preset in Button(preset.label) { adding = preset; key = "" } }
				}
			} header: {
				Text("Model services with your own key")
			} footer: {
				Text("Keys go to the macOS keychain and are read only when a request needs them.").foregroundStyle(.secondary)
			}
			Section("On this Mac") {
				if let local {
					if local.servers.isEmpty {
						Text("No model server is running on this Mac. Install Ollama or LM Studio, and its models appear here.").foregroundStyle(.secondary)
					}
					ForEach(local.servers, id: \.port) { server in
						LabeledContent(server.label, value: "\(server.models.count) model\(server.models.count == 1 ? "" : "s")")
					}
					if local.ollama != nil {
						ForEach(local.suggestions.filter { $0.fits }.prefix(6)) { model in
							LabeledContent {
								if model.installed { Text("Installed").foregroundStyle(.secondary) }
								else if let pull = local.pulls.first(where: { $0.model == model.model }), pull.done != true {
									ProgressView(value: pull.completed ?? 0, total: max(pull.total ?? 1, 1)).frame(width: 120)
								} else {
									Button("Download \(Int(model.sizeGB.rounded())) GB") { Task { try? await app.connection.pullLocalModel(model.model); await reload() } }
								}
							} label: {
								VStack(alignment: .leading) {
									Text(model.label)
									Text(model.about).font(.caption).foregroundStyle(.secondary).lineLimit(2)
								}
							}
						}
					}
				} else {
					ProgressView()
				}
			}
		}
		.formStyle(.grouped)
		.task { await reload() }
		.sheet(item: $adding) { preset in
			VStack(alignment: .leading, spacing: 14) {
				Text("Add a \(preset.label) Key").font(.headline)
				Text(preset.note).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
				SecureField("Key", text: $key).textFieldStyle(.roundedBorder)
				if let url = preset.keyUrl.flatMap(URL.init(string:)) { Link("Get a key from \(preset.label)", destination: url) }
				if let error { Text(error).foregroundStyle(.red).font(.callout) }
				HStack {
					Spacer()
					Button("Cancel") { adding = nil }.keyboardShortcut(.cancelAction)
					Button(working ? "Checking…" : "Add") {
						Task {
							working = true
							defer { working = false }
							do {
								let added = try await app.connection.addProvider(preset: preset.id, key: key)
								key = ""
								adding = nil
								error = nil
								app.say("Added \(preset.label): \(added.models) models.")
								await reload()
								await app.refreshModels()
							} catch let failure {
								error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
							}
						}
					}
					.keyboardShortcut(.defaultAction)
					.disabled(key.isEmpty || working)
				}
			}
			.padding(20)
			.frame(width: 420)
		}
	}

	private func reload() async {
		providers = try? await app.connection.providers()
		local = try? await app.connection.localModels()
	}
}

private struct LabSettings: View {
	@Environment(AppModel.self) private var app
	@AppStorage("advanced") private var advanced = false
	@State private var sandboxes: [String: [LabSandbox]] = [:]
	@State private var checks: [String: [CheckRow]] = [:]
	@State private var checking: String?

	var body: some View {
		Form {
			if app.sites.isEmpty {
				Section {
					Text("You haven't joined a lab yet. A lab sends an invite link; open it, or choose Add a Lab and paste it.").foregroundStyle(.secondary)
				}
			}
			ForEach(app.sites) { site in
				Section {
					LabeledContent("Status") {
						Text(site.signedIn ? "Signed in as \(site.who ?? "you")" : site.error ?? "Signed out").foregroundStyle(site.signedIn ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.orange))
					}
					LabeledContent("Offers", value: "\(site.models) model\(site.models == 1 ? "" : "s"), \(site.tools) tools\(site.sandbox ? ", a sandbox" : "")\(site.desktop != nil ? ", a desktop" : "")")
					if site.keepsDataInside == true { Text("Keeps its data inside: its sessions use its own models and stay in its sandbox.").font(.callout).foregroundStyle(.secondary) }
					HStack {
						if site.signedIn { Button("Sign Out") { Task { await app.signOut(site.name) } } }
						else { Button("Sign In…") { Task { _ = await app.signIn(site.name) } } }
						Button("Reconnect") { Task { await app.reconnectLabs() } }
						Spacer()
						Button("Remove…", role: .destructive) { app.confirmRemoveLab(site.name) }
					}
					if advanced, site.signedIn {
						DisclosureGroup("Sandboxes") {
							ForEach(sandboxes[site.name] ?? []) { box in
								LabeledContent(box.name ?? box.id) {
									Text([box.status, box.image, box.network].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.secondary)
								}
							}
						}
						.task { sandboxes[site.name] = try? await app.connection.labSandboxes(site.name) }
						DisclosureGroup("Lab contract check") {
							if let rows = checks[site.name] {
								ForEach(rows, id: \.row) { row in
									HStack(alignment: .firstTextBaseline) {
										Image(systemName: row.status == "pass" ? "checkmark.circle" : row.status == "fail" ? "xmark.octagon" : "minus.circle")
											.foregroundStyle(row.status == "pass" ? .green : row.status == "fail" ? .red : .secondary)
										Text(row.row)
										Spacer()
										Text(row.detail ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(2)
									}
								}
							}
							Button(checking == site.name ? "Checking…" : "Run the Check") {
								Task {
									checking = site.name
									defer { checking = nil }
									do { checks[site.name] = try await app.connection.labCheck(site.name) } catch { app.said(error) }
								}
							}
							.disabled(checking != nil)
						}
					}
				} header: {
					HStack(spacing: 8) {
						PlaceDot(place: app.place(of: site.name))
						Text(site.displayTitle)
					}
				}
			}
			Section {
				Button("Add a Lab…") { app.joining = JoinRequest() }
			}
		}
		.formStyle(.grouped)
	}
}

private struct UpdateSettings: View {
	@Environment(AppModel.self) private var app
	@State private var status: UpdateStatus?
	@State private var working = false

	var body: some View {
		Form {
			LabeledContent("This version", value: status?.current ?? app.engineVersion ?? "")
			if let status {
				if let latest = status.latest, latest != status.current {
					LabeledContent("Available", value: latest)
					ForEach(status.notes ?? [], id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
					Button(working ? "Installing…" : "Install \(latest)") {
						Task {
							working = true
							defer { working = false }
							do {
								let result = try await app.connection.applyUpdate()
								app.say(result.restart ? "Installed \(result.version). Quit and open EnrichedLab again to use it." : "Installed \(result.version).")
							} catch { app.said(error) }
						}
					}
					.disabled(working)
				} else if let error = status.error {
					Text(error).foregroundStyle(.secondary)
				} else {
					Text("EnrichedLab is up to date.").foregroundStyle(.secondary)
				}
			}
			Button("Check Now") { Task { status = try? await app.connection.checkUpdate(force: true) } }
		}
		.formStyle(.grouped)
		.task { status = try? await app.connection.checkUpdate() }
	}
}

/// Add a lab from its invite: paste the link (or its parts), then sign in.
struct JoinLabView: View {
	@Environment(AppModel.self) private var app
	@Environment(\.dismiss) private var dismiss
	@AppStorage("advanced") private var advanced = false
	@State var request: JoinRequest
	@State private var invite = ""
	@State private var working = false
	@State private var error: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			Text("Add a Lab").font(.title3.weight(.semibold))
			Text("Paste the invite link your lab sent. EnrichedLab adds the lab, then opens its sign-in page in your browser.")
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
			TextField("Invite link", text: $invite)
				.textFieldStyle(.roundedBorder)
				.onChange(of: invite) { _, text in read(text) }
			if !request.url.isEmpty || advanced {
				Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
					GridRow { Text("Address").foregroundStyle(.secondary); TextField("https://lab.example.org", text: $request.url).textFieldStyle(.roundedBorder) }
					GridRow { Text("Short name").foregroundStyle(.secondary); TextField("lab", text: $request.name).textFieldStyle(.roundedBorder) }
					GridRow { Text("Shown as").foregroundStyle(.secondary); TextField("Lab name", text: $request.title).textFieldStyle(.roundedBorder) }
				}
				if advanced { Toggle("Keep this lab's work inside it", isOn: $request.isolated) }
			}
			if let error { Text(error).foregroundStyle(.red).font(.callout).fixedSize(horizontal: false, vertical: true) }
			HStack {
				Spacer()
				Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
				Button(working ? "Adding…" : "Add and Sign In") {
					Task {
						working = true
						defer { working = false }
						if let failure = await app.join(request) { error = failure } else { dismiss() }
					}
				}
				.keyboardShortcut(.defaultAction)
				.buttonStyle(.borderedProminent)
				.disabled(working || request.url.isEmpty || request.name.isEmpty)
			}
		}
		.padding(22)
		.frame(width: 480)
		.onAppear { if !request.url.isEmpty { invite = "" } }
	}

	/// An invite is enrichedlab://join?url=…&name=…&title=…, or an https link carrying the same query.
	private func read(_ text: String) {
		guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespaces)), let items = parts.queryItems else { return }
		let value = { (name: String) in items.first { $0.name == name }?.value }
		if let url = value("url") { request.url = url }
		if let name = value("name") { request.name = name }
		if let title = value("title") { request.title = title }
		request.isolated = value("isolated") == "1"
		error = nil
	}
}
