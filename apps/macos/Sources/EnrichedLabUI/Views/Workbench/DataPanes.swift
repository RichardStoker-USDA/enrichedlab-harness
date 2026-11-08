import Charts
import EnrichedLabKit
import SwiftUI

/// Rows and columns from a view's data: CSV, TSV or a JSON array of records. Values stay exactly as the file has them.
struct DataTable: Sendable {
	struct Row: Identifiable, Sendable {
		let id: Int
		let values: [String]
	}

	var columns: [String]
	var rows: [Row]

	static func parse(name: String, text: String) -> DataTable? {
		let lower = name.lowercased()
		if lower.hasSuffix(".json") || text.first == "[" {
			guard let data = text.data(using: .utf8), let records = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
			var columns: [String] = []
			for record in records.prefix(200) { for key in record.keys where !columns.contains(key) { columns.append(key) } }
			let rows = records.enumerated().map { i, record in Row(id: i, values: columns.map { record[$0].map { "\($0)" } ?? "" }) }
			return DataTable(columns: columns, rows: rows)
		}
		let separator: Character = lower.hasSuffix(".tsv") || (text.prefix(2000).filter { $0 == "\t" }.count > text.prefix(2000).filter { $0 == "," }.count) ? "\t" : ","
		let records = csv(text, separator: separator)
		guard let header = records.first else { return nil }
		let rows = records.dropFirst().enumerated().map { i, values in Row(id: i, values: header.indices.map { values.indices.contains($0) ? values[$0] : "" }) }
		return DataTable(columns: header, rows: rows)
	}

	/// RFC 4180: quoted fields, doubled quotes, newlines inside quotes.
	static func csv(_ text: String, separator: Character) -> [[String]] {
		var records: [[String]] = []
		var field = ""
		var record: [String] = []
		var quoted = false
		var iterator = text.makeIterator()
		var pending: Character?
		while let c = pending ?? iterator.next() {
			pending = nil
			if quoted {
				if c == "\"" {
					if let next = iterator.next() {
						if next == "\"" { field.append("\"") } else { quoted = false; pending = next }
					} else { quoted = false }
				} else { field.append(c) }
			} else if c == "\"" && field.isEmpty {
				quoted = true
			} else if c == separator {
				record.append(field); field = ""
			} else if c == "\n" || c == "\r\n" {
				record.append(field); field = ""
				if !(record.count == 1 && record[0].isEmpty) { records.append(record) }
				record = []
			} else if c != "\r" {
				field.append(c)
			}
		}
		if !field.isEmpty || !record.isEmpty { record.append(field); records.append(record) }
		return records
	}
}

/// Sorts rows by one column: as numbers when both values are numbers, otherwise as text.
struct ColumnOrder: SortComparator {
	var column: Int
	var order: SortOrder = .forward

	func compare(_ a: DataTable.Row, _ b: DataTable.Row) -> ComparisonResult {
		let x = a.values.indices.contains(column) ? a.values[column] : ""
		let y = b.values.indices.contains(column) ? b.values[column] : ""
		let result: ComparisonResult
		if let p = Double(x), let q = Double(y) { result = p < q ? .orderedAscending : p > q ? .orderedDescending : .orderedSame }
		else { result = x.localizedStandardCompare(y) }
		return order == .forward ? result : result == .orderedAscending ? .orderedDescending : result == .orderedDescending ? .orderedAscending : .orderedSame
	}
}

/// A table view: sort by any column, filter rows, copy cells. Millions of rows scroll natively.
struct TablePane: View {
	@Environment(AppModel.self) private var app
	var view: CanvasSummary
	@State private var table: DataTable?
	@State private var error: String?
	@State private var filter = ""
	@State private var order: [ColumnOrder] = []
	@State private var selection = Set<Int>()
	@State private var shown: [DataTable.Row] = []

	/// What the shown rows depend on: the data's version, the filter and the order.
	private struct Shape: Equatable { var version: String; var filter: String; var order: [ColumnOrder] }

	var body: some View {
		VStack(spacing: 0) {
			if let table {
				Table(shown, selection: $selection, sortOrder: $order) {
					TableColumnForEach(Array(table.columns.enumerated()), id: \.offset) { i, name in
						TableColumn(name, sortUsing: ColumnOrder(column: i)) { row in
							let value = row.values.indices.contains(i) ? row.values[i] : ""
							Text(value).font(.system(size: 12, design: Double(value) != nil ? .monospaced : .default)).lineLimit(1)
						}
					}
				}
				.contextMenu(forSelectionType: Int.self) { ids in
					Button("Copy Rows") { copyRows(ids, table) }
				}
				Divider()
				HStack {
					Text("\(shown.count.formatted()) of \(table.rows.count.formatted()) rows · \(table.columns.count) columns").font(.caption).foregroundStyle(.secondary).monospacedDigit()
					Spacer()
					TextField("Filter rows", text: $filter).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 6)
			} else if let error {
				ContentUnavailableView("Can't Show This Table", systemImage: "tablecells", description: Text(error))
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.task(id: "\(view.id):\(view.version)") { await load() }
		// Filtering and sorting run off the main thread, only when the filter, the order or the data change.
		.task(id: Shape(version: "\(view.version):\(table?.columns.count ?? -1):\(table?.rows.count ?? -1)", filter: filter, order: order)) {
			guard let table else { return }
			if !filter.isEmpty { try? await Task.sleep(for: .milliseconds(150)) }
			guard !Task.isCancelled else { return }
			let words = filter.trimmingCharacters(in: .whitespaces).lowercased()
			let order = order
			let rows = await Task.detached(priority: .userInitiated) {
				var rows = table.rows
				if !words.isEmpty { rows = rows.filter { $0.values.contains { $0.lowercased().contains(words) } } }
				if !order.isEmpty { rows.sort(using: order) }
				return rows
			}.value
			// A newer filter, order or version replaced this one while it ran: its own result follows.
			guard !Task.isCancelled else { return }
			shown = rows
		}
	}

	private func load() async {
		do {
			let data = try await app.connection.viewData(view.id)
			if data.base64 != nil, data.text == nil {
				error = "Parquet tables open in a terminal for now: ask the agent to save it as CSV, or to summarize it."
				return
			}
			let name = data.name, text = data.text ?? ""
			// Large files parse off the main thread.
			guard let parsed = await Task.detached(priority: .userInitiated, operation: { DataTable.parse(name: name, text: text) }).value else { error = "The data didn't read as a table."; return }
			// The rows shown change with the columns, so no row is drawn against columns it doesn't have.
			shown = parsed.rows
			table = parsed
		} catch let failure {
			error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
		}
	}

	private func copyRows(_ ids: Set<Int>, _ table: DataTable) {
		let lines = [table.columns.joined(separator: "\t")] + table.rows.filter { ids.contains($0.id) }.map { $0.values.joined(separator: "\t") }
		copyText(lines.joined(separator: "\n"), what: "\(ids.count) row\(ids.count == 1 ? "" : "s")", app: app)
	}
}

/// A plot of two columns, colored by a third: scatter or line, drawn with Swift Charts' vectorized plots.
struct PlotPane: View {
	@Environment(AppModel.self) private var app
	var view: CanvasSummary
	@State private var points: [PlotPoint] = []
	@State private var error: String?
	@State private var loaded = false
	/// The color groups in the order they first appear, for the UC Davis series colors.
	@State private var groups: [String] = []

	struct PlotPoint: Identifiable, Sendable {
		let id: Int
		let x: Double
		let y: Double
		let group: String
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			if let error {
				ContentUnavailableView("Can't Draw This Plot", systemImage: "chart.xyaxis.line", description: Text(error))
			} else if !loaded {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			} else {
				Text(view.title).font(.headline)
				chart
					.chartXAxisLabel(view.plot?.x ?? "x")
					.chartYAxisLabel(view.plot?.y ?? "y")
					.chartLegend(view.plot?.color == nil ? .hidden : .visible)
					.chartForegroundStyleScale(domain: groups, range: groups.indices.map { Theme.series[$0 % Theme.series.count] })
					.id(groups)
				Text("\(points.count.formatted()) points").font(.caption).foregroundStyle(.secondary)
			}
		}
		.padding(16)
		.task(id: "\(view.id):\(view.version)") { await load() }
	}

	@ViewBuilder private var chart: some View {
		if view.plot?.type == "line" {
			Chart {
				LinePlot(points, x: .value(view.plot?.x ?? "x", \.x), y: .value(view.plot?.y ?? "y", \.y))
					.foregroundStyle(by: .value(view.plot?.color ?? "Series", \.group))
			}
		} else {
			Chart {
				PointPlot(points, x: .value(view.plot?.x ?? "x", \.x), y: .value(view.plot?.y ?? "y", \.y))
					.foregroundStyle(by: .value(view.plot?.color ?? "Series", \.group))
					.symbolSize(points.count > 20_000 ? 4 : 18)
			}
		}
	}

	private func load() async {
		defer { loaded = true }
		do {
			let data = try await app.connection.viewData(view.id)
			guard let table = DataTable.parse(name: data.name, text: data.text ?? ""), let spec = view.plot else { error = "The data didn't read as a table."; return }
			guard let xi = table.columns.firstIndex(of: spec.x), let yi = table.columns.firstIndex(of: spec.y) else { error = "The columns \(spec.x) and \(spec.y) aren't in the data."; return }
			let ci = spec.color.flatMap { table.columns.firstIndex(of: $0) }
			let made = table.rows.compactMap { row -> PlotPoint? in
				guard let x = Double(row.values[xi]), let y = Double(row.values[yi]) else { return nil }
				return PlotPoint(id: row.id, x: x, y: y, group: ci.map { row.values[$0] } ?? "All")
			}
			// The color scale's domain holds every group before any point draws: Charts stops on a value outside it.
			var seen = Set<String>()
			groups = made.compactMap { seen.insert($0.group).inserted ? $0.group : nil }
			points = made
			if points.isEmpty { error = "\(spec.x) and \(spec.y) have no numbers to plot." }
		} catch let failure {
			error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
		}
	}
}
