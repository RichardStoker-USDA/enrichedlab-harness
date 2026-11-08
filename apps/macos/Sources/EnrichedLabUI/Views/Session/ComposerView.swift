import AppKit
import EnrichedLabKit
import SwiftUI
import UniformTypeIdentifiers

/// Under the run sheet: questions not shown at a step, and the composer.
struct ComposerArea: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		VStack(spacing: 10) {
			ForEach(session.looseQuestions) { request in
				ApprovalCard(request: request, session: session)
			}
			Composer(session: session)
		}
		.frame(maxWidth: Theme.measure + 40)
		.padding(.horizontal, 24)
		.padding(.bottom, 16)
		.padding(.top, 8)
		.frame(maxWidth: .infinity)
	}
}

/// What the person writes, where it runs and with which model, and Send or Stop.
struct Composer: View {
	@Environment(AppModel.self) private var app
	@AppStorage("advanced") private var advanced = false
	var session: SessionModel
	@State private var text = ""
	@State private var images: [Attachment] = []
	@FocusState private var focused: Bool
	@State private var sending = false

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if !images.isEmpty { AttachmentStrip(images: $images) }
			TextField(session.busy ? "Add to the current turn" : "Ask for anything", text: $text, axis: .vertical)
				.textFieldStyle(.plain)
				.font(.system(size: 14.5))
				.lineLimit(1 ... 12)
				.focused($focused)
				.onSubmit(send)
				.onKeyPress(.return, phases: .down) { press in
					// Shift-Return starts a new line; Return sends.
					guard press.modifiers.contains(.shift) else { return .ignored }
					text += "\n"
					return .handled
				}
				.onPasteCommand(of: [.png, .tiff, .jpeg, .fileURL]) { providers in addImages(providers) }
				.accessibilityLabel("Message")
			HStack(spacing: 10) {
				PlaceMenu(session: session)
				Divider().frame(height: 14)
				ModelMenu(session: session)
				Divider().frame(height: 14)
				ApprovalsMenu(session: session)
				Spacer(minLength: 6)
				if advanced, let status = session.status { ContextGauge(context: status.context, rate: status.rate) }
				Button {
					pickImages()
				} label: {
					Image(systemName: "photo.badge.plus")
				}
				.buttonStyle(.borderless)
				.help(session.model?.vision == false ? "This model can't see images" : "Attach images")
				.disabled(session.model?.vision == false)
				if session.busy && trimmed.isEmpty {
					Button {
						Task { await session.stop() }
					} label: {
						Image(systemName: "stop.fill").font(.system(size: 11, weight: .bold)).frame(width: 26, height: 26)
					}
					.buttonStyle(.plain)
					.background(Color.primary.opacity(0.85), in: .circle)
					.foregroundStyle(Color(nsColor: .windowBackgroundColor))
					.help("Stop (⌘.)")
					.accessibilityLabel("Stop")
				} else {
					Button(action: send) {
						Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).frame(width: 26, height: 26)
					}
					.buttonStyle(.plain)
					.background(trimmed.isEmpty ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Theme.accent), in: .circle)
					.foregroundStyle(trimmed.isEmpty ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.onAccent))
					.disabled(trimmed.isEmpty || sending)
					.help(session.busy ? "Add to the current turn (Return)" : "Send (Return)")
					.accessibilityLabel("Send")
				}
			}
			.font(.callout)
		}
		.padding(.horizontal, 14)
		.padding(.top, 12)
		.padding(.bottom, 9)
		.glass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(focused ? Theme.accent.opacity(0.45) : Color.clear, lineWidth: 1))
		.dropDestination(for: URL.self) { urls, _ in
			addFiles(urls)
			return true
		}
		.onAppear {
			text = UserDefaults.standard.string(forKey: "draft.\(session.id)") ?? ""
			focused = true
		}
		.onChange(of: text) { _, value in UserDefaults.standard.set(value.isEmpty ? nil : value, forKey: "draft.\(session.id)") }
		.onChange(of: session.draft, initial: true) { _, returned in
			guard let returned else { return }
			text = text.isEmpty ? returned : "\(returned)\n\n\(text)"
			session.draft = nil
		}
	}

	private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

	private func send() {
		let message = trimmed
		guard !message.isEmpty, !sending else { return }
		let parts = images.map(\.part)
		sending = true
		text = ""
		images = []
		Task {
			let ok = await session.send(message, images: parts.isEmpty ? nil : parts)
			// A send that didn't reach the engine comes back, so nothing typed is lost.
			if !ok { text = message + (text.isEmpty ? "" : "\n\n\(text)") }
			sending = false
		}
	}

	private func pickImages() {
		let panel = NSOpenPanel()
		panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .heic, .tiff]
		panel.allowsMultipleSelection = true
		panel.canChooseDirectories = false
		if panel.runModal() == .OK { addFiles(panel.urls) }
	}

	private func addFiles(_ urls: [URL]) {
		for url in urls {
			if let attachment = Attachment(url: url) { images.append(attachment) }
			else { app.say("\(url.lastPathComponent) isn't an image. Put files in the project folder and mention them instead.") }
		}
	}

	private func addImages(_ providers: [NSItemProvider]) {
		for provider in providers {
			if provider.canLoadObject(ofClass: NSImage.self) {
				_ = provider.loadObject(ofClass: NSImage.self) { image, _ in
					guard let image = image as? NSImage else { return }
					Task { @MainActor in if let attachment = Attachment(image: image) { images.append(attachment) } }
				}
			}
		}
	}
}

/// An image going with the next message, as PNG or as the file's own JPEG.
struct Attachment: Identifiable {
	let id = UUID()
	let image: NSImage
	let part: Part

	private init(image: NSImage, part: Part) {
		self.image = image
		self.part = part
	}

	init?(url: URL) {
		guard let data = try? Data(contentsOf: url), let image = NSImage(data: data) else { return nil }
		let type = UTType(filenameExtension: url.pathExtension)
		if type == .jpeg || type == .png {
			self.init(image: image, part: .image(mime: type == .png ? "image/png" : "image/jpeg", data: data.base64EncodedString()))
		} else {
			self.init(image: image)
		}
	}

	init?(image: NSImage) {
		guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
		self.init(image: image, part: .image(mime: "image/png", data: png.base64EncodedString()))
	}
}

private struct AttachmentStrip: View {
	@Binding var images: [Attachment]

	var body: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 8) {
				ForEach(images) { attachment in
					Image(nsImage: attachment.image)
						.resizable()
						.scaledToFill()
						.frame(width: 56, height: 56)
						.clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
						.overlay(alignment: .topTrailing) {
							Button {
								images.removeAll { $0.id == attachment.id }
							} label: {
								Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
							}
							.buttonStyle(.plain)
							.padding(3)
							.accessibilityLabel("Remove image")
						}
				}
			}
		}
		.scrollIndicators(.never)
	}
}

/// How full the model's context is, and the last response's speed (advanced view).
struct ContextGauge: View {
	var context: EnrichedLabKit.ContextGauge
	var rate: Double?

	var body: some View {
		HStack(spacing: 6) {
			Gauge(value: Double(min(context.used, context.threshold)), in: 0 ... Double(max(context.threshold, 1))) {}
				.gaugeStyle(.accessoryCircularCapacity)
				.scaleEffect(0.42)
				.frame(width: 18, height: 18)
				.tint(Double(context.used) / Double(max(context.threshold, 1)) > 0.85 ? .orange : Theme.accent)
			if let rate { Text("\(Int(rate)) tok/s").font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1).fixedSize() }
		}
		.help("\(context.estimated ? "About " : "")\(tokenCount(context.used)) of \(tokenCount(context.threshold)) tokens before older turns are summarized (window \(tokenCount(context.window)))")
	}
}

/// Where the session works: this Mac or a lab's sandbox. Choosing another place reviews the move first.
struct PlaceMenu: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		Menu {
			Section("Runs On") {
				ForEach(app.places) { place in
					Button {
						Task { await session.requestMove(to: place) }
					} label: {
						if place.id == session.place.id { Label(label(place), systemImage: "checkmark") } else { Text(label(place)) }
					}
					.disabled(!place.isLocal && place.site?.signedIn == true && !place.ready)
				}
			}
			Divider()
			Button("Add a Lab…") { app.joining = JoinRequest() }
		} label: {
			HStack(spacing: 6) {
				PlaceDot(place: session.place)
				Text(session.place.runsLabel).lineLimit(1)
			}
		}
		.menuStyle(.button)
		.buttonStyle(.borderless)
		.tint(.primary)
		.fixedSize()
		.help(session.place.isLocal ? "Runs on This Mac, contained to the project folder. Choose to move it to a lab." : "Runs in the \(session.place.title) sandbox")
		.disabled(session.busy || session.moving != nil)
	}

	private func label(_ place: Place) -> String {
		if let site = place.site, !site.signedIn { return "\(place.title) — sign in" }
		return place.isLocal ? place.title : "\(place.title) sandbox"
	}
}

/// How much the session asks before it acts: before changes, only for what history can't take back, or never.
struct ApprovalsMenu: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel

	var body: some View {
		let current = session.permissionMode
		Menu {
			Section("Asks Before It Acts") {
				ForEach(PermissionMode.allCases, id: \.self) { mode in
					Button {
						Task { await session.setPermissions(mode == app.ui.permissionMode ? nil : mode) }
					} label: {
						if mode == current { Image(systemName: "checkmark") }
						Text(mode.title)
						Text(mode.detail)
					}
				}
			}
			Divider()
			Text("New sessions start with “\(app.ui.permissionMode.title)”. Change it in Settings.")
		} label: {
			HStack(spacing: 5) {
				Image(systemName: current == .full ? "bolt.shield" : current == .auto ? "checkmark.shield" : "hand.raised")
				Text(current.short).lineLimit(1)
			}
		}
		.menuStyle(.button)
		.buttonStyle(.borderless)
		.tint(.primary)
		.fixedSize()
		.help("\(current.title): \(current.detail)")
		.accessibilityLabel("Approvals: \(current.title)")
	}
}

/// Which model answers, grouped by where it runs, and how hard it thinks (advanced view).
struct ModelMenu: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openSettings) private var openSettings
	@AppStorage("advanced") private var advanced = false
	var session: SessionModel

	var body: some View {
		let current = session.status?.model ?? session.summary.model
		let allowed = app.allowed(site: session.summary.site)
		Menu {
			ForEach(modelGroups(allowed)) { group in
				Section(group.label) {
					ForEach(group.models) { model in
						Button {
							Task { await session.setModel(model.ref) }
						} label: {
							if model.ref == current { Label(model.label, systemImage: "checkmark") } else { Text(model.label) }
						}
					}
				}
			}
			if advanced, let model = app.model(current), !model.efforts.isEmpty {
				Divider()
				Picker("Effort", selection: Binding(get: { session.status?.effort ?? model.defaultEffort ?? "" }, set: { effort in Task { await session.setModel(nil, effort: effort) } })) {
					ForEach(model.efforts, id: \.self) { Text($0.capitalized).tag($0) }
				}
			}
			Divider()
			Button("Model Services…") {
				app.showSettingsTab = .models
				openSettings()
			}
		} label: {
			HStack(spacing: 5) {
				if let model = app.model(current) {
					Image(systemName: model.where.isPrivate ? "lock" : "cloud").font(.caption).foregroundStyle(.secondary)
					Text(model.label).lineLimit(1)
					if advanced, let effort = session.status?.effort { Text(effort).foregroundStyle(.secondary) }
				} else {
					Text(current.isEmpty ? "Choose a model" : current).lineLimit(1)
				}
			}
		}
		.menuStyle(.button)
		.buttonStyle(.borderless)
		.tint(.primary)
		.fixedSize()
		.help(app.model(current).map { whereNote($0.where) } ?? "Choose a model")
	}
}
