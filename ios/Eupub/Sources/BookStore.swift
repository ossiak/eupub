import Foundation

/// The current book's extraction directory in the app container, shared between
/// the Bridge (sets it when a book is opened) and the SchemeHandler (serves
/// /book/… from it). The iOS analog of MainActivity.currentBookDir. Locked
/// because the Bridge writes it off a work queue while the scheme handler reads
/// it on the main thread.
final class BookStore {
    private let lock = NSLock()
    private var dir: URL?

    var currentBookDir: URL? {
        get { lock.lock(); defer { lock.unlock() }; return dir }
        set { lock.lock(); dir = newValue; lock.unlock() }
    }
}
