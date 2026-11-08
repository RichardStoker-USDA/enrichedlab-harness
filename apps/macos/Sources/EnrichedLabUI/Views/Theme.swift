import AppKit
import EnrichedLabKit
import SwiftUI

// The window's constants (docs/design.md): the same color roles as the web window (packages/web/src/styles/app.css),
// UC Davis in light (white, Aggie Blue, gold sparingly) and BFI Index in dark (a black canvas, UC Davis black tints,
// Aggie Gold as the accent with Aggie Blue letters on it). Place markers in UC Davis secondary colors, system type
// everywhere, a reading measure for the run sheet. Liquid Glass and system controls stay as macOS draws them.

extension NSColor {
	static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
		NSColor(name: nil) { appearance in
			appearance.bestMatch(from: [.darkAqua, .vibrantDark, .accessibilityHighContrastDarkAqua]) != nil ? dark : light
		}
	}

	convenience init(hex: UInt32) {
		self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
	}
}

public enum Theme {
	static func pair(_ light: UInt32, _ dark: UInt32) -> Color { Color(nsColor: .dynamic(light: NSColor(hex: light), dark: NSColor(hex: dark))) }

	/// The window behind everything: white, or black (BFI Index).
	public static let canvas = pair(0xFFFFFF, 0x000000)
	/// Cards, a question, a step's command: Aggie Blue at a breath, or black 90.
	public static let surface = pair(0xF5F7FA, 0x191919)
	/// Inline code, table stripes, a selected tab's fill.
	public static let surface2 = pair(0xEDF1F5, 0x333333)
	/// Hairlines between things.
	public static let rule = pair(0xDFE4EB, 0x333333)
	/// Body text: a blue-black, or near white. Secondary text derives from it.
	public static let text = pair(0x0B1A2E, 0xF2F2F2)
	/// The person's own requests in the run sheet: Aggie Blue, or white.
	public static let promptText = pair(0x022851, 0xFFFFFF)
	/// Links and accent words: Aggie Blue 80 (readable as small text), or Aggie Gold.
	public static let accentText = pair(0x1D4776, 0xFFBF00)
	/// A selected row or tab: Aggie Blue at 7.5 percent, or white at 12.
	public static let selected = Color(nsColor: .dynamic(light: NSColor(hex: 0x022851).withAlphaComponent(0.075), dark: NSColor.white.withAlphaComponent(0.12)))
	/// Code blocks.
	public static let code = pair(0xF6F8FB, 0x191919)
	public static let ok = pair(0x1E6B43, 0x7FC8A0)
	public static let bad = pair(0xB3261E, 0xFF8A80)
	/// Series in plots, in order: UC Davis primary and secondary colors that stay apart from each other and readable
	/// as marks on white or on black.
	public static let series: [Color] = [
		pair(0x022851, 0xFFBF00), pair(0xFFBF00, 0x00B2E3), pair(0x008EAA, 0x6CCA98),
		pair(0x266041, 0xFFD24C), pair(0xC10230, 0xF18A00), pair(0x4F7094, 0xB3C1D1),
	]

	/// Aggie Gold in both: fills and marks only, never small text on white.
	public static let gold = Color(nsColor: NSColor(hex: 0xFFBF00))
	/// Warnings: a dark gold that reads as small text on white, or Aggie Gold 70 on black.
	public static let warn = pair(0x7A5300, 0xFFD24C)

	/// Aggie Blue #022851 in light, Aggie Gold #FFBF00 in dark.
	public static let accent = Color(nsColor: .dynamic(light: NSColor(hex: 0x022851), dark: NSColor(hex: 0xFFBF00)))
	/// Text on the accent: white on blue, Aggie Blue on gold.
	public static let onAccent = Color(nsColor: .dynamic(light: .white, dark: NSColor(hex: 0x022851)))

	/// Place markers in the order labs are listed. This computer is neutral; the color is never the only signal.
	public static func place(_ index: Int) -> Color {
		switch index {
		case 0: Color(nsColor: .tertiaryLabelColor)
		case 1: accent
		case 2: Color(nsColor: .dynamic(light: NSColor(hex: 0x266041), dark: NSColor(hex: 0x6CCA98)))
		case 3: Color(nsColor: NSColor(hex: 0x008EAA))
		default: Color(nsColor: NSColor(hex: 0x00B2E3))
		}
	}

	/// Discovery mode's mark: Aggie Gold in both appearances, with dark text on it.
	public static let discovery = Color(nsColor: .dynamic(light: NSColor(hex: 0xB07D00), dark: NSColor(hex: 0xFFBF00)))

	/// The run sheet's reading measure, about 70 characters of prose.
	public static let measure: CGFloat = 720
	public static let prose = Font.system(size: 15)
	public static let proseSpacing: CGFloat = 4.5
	public static let prompt = Font.system(size: 18, weight: .semibold)
	public static let mono = Font.system(size: 12, design: .monospaced)
	public static let small = Font.system(size: 12)
}

/// A place's marker: a small dot in its color, the name always beside it.
struct PlaceDot: View {
	var place: Place
	var size: CGFloat = 7

	var body: some View {
		Circle()
			.fill(Theme.place(place.index))
			.frame(width: size, height: size)
			.overlay {
				if place.isLocal { Circle().strokeBorder(Color(nsColor: .secondaryLabelColor), lineWidth: 1) }
			}
			.accessibilityHidden(true)
	}
}

extension View {
	/// Run sheet prose: the reading size and line spacing, selectable.
	func prose() -> some View {
		font(Theme.prose).lineSpacing(Theme.proseSpacing).textSelection(.enabled)
	}
}

/// Copy text to the clipboard, and say so.
@MainActor
func copyText(_ text: String, what: String, app: AppModel) {
	NSPasteboard.general.clearContents()
	NSPasteboard.general.setString(text, forType: .string)
	app.say("Copied \(what).")
}

/// Show a folder in Finder.
@MainActor
func revealInFinder(_ path: String) {
	NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
}

extension View {
	/// Liquid Glass on macOS 26 and later; the closest material before it, so the app runs on macOS 15 too.
	@ViewBuilder func glass(in shape: some Shape, interactive: Bool = false) -> some View {
		if #available(macOS 26, *) {
			glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
		} else {
			background(.regularMaterial, in: shape)
				.overlay(shape.stroke(.separator, lineWidth: 0.5))
		}
	}
}
