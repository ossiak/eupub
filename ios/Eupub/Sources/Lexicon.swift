import Foundation
import SQLite3

/// Read-only native SQLite lexicon (www/lexicon.db), queried per chapter — the
/// iOS analog of MainActivity.lexicon / lexiconSubset. The mobile engine bundle
/// omits the baked-in table and asks the host for each chapter's subset instead,
/// so this keeps the app small while still reforming every word it can.
final class Lexicon {
    private var db: OpaquePointer?
    // SQLite needs bound text to outlive the step; SQLITE_TRANSIENT tells it to copy.
    private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init() {
        let url = Bundle.main.resourceURL!.appendingPathComponent("www/lexicon.db")
        if sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
            NSLog("[eupub] lexicon open failed: \(String(cString: sqlite3_errmsg(db)))")
            sqlite3_close(db)
            db = nil
        }
    }

    deinit { if db != nil { sqlite3_close(db) } }

    /// [[word, {encoding, pos:[…], spellings:[…]}], …] for the words present,
    /// matching MainActivity.lexiconSubset's shape (consumed by the engine).
    func subset(_ words: [String]) -> [[Any]] {
        guard let db = db, !words.isEmpty else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT enc, pos, sp FROM lex WHERE k = ?", -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        var out: [[Any]] = []
        for w in words {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            sqlite3_bind_text(stmt, 1, w, -1, SQLITE_TRANSIENT)
            if sqlite3_step(stmt) == SQLITE_ROW {
                let entry: [String: Any] = [
                    "encoding": Int(sqlite3_column_int(stmt, 0)),
                    "pos": splitPipe(text(stmt, 1)),
                    "spellings": splitPipe(text(stmt, 2)),
                ]
                out.append([w, entry])
            }
        }
        return out
    }

    private func text(_ stmt: OpaquePointer?, _ col: Int32) -> String {
        guard let c = sqlite3_column_text(stmt, col) else { return "" }
        return String(cString: c)
    }

    private func splitPipe(_ s: String) -> [String] {
        s.isEmpty ? [] : s.split(separator: "|").map(String.init)
    }
}
