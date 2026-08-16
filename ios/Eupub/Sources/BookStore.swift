import Foundation

/// The current book's extraction directory in the app container, shared between
/// the Bridge (sets it when a book is opened) and the SchemeHandler (serves
/// /book/… from it). The iOS analog of MainActivity.currentBookDir. Locked
/// because the Bridge writes it off a work queue while the scheme handler reads
/// it on the main thread.
final class BookStore {
    private let lock = NSLock()
    private var dir: URL?
    private var pdfDir: URL?

    var currentBookDir: URL? {
        get { lock.lock(); defer { lock.unlock() }; return dir }
        set { lock.lock(); dir = newValue; lock.unlock() }
    }

    /// The directory holding the current PDF, served at /pdf/… — the analog of
    /// currentBookDir for the embedded PDF viewer (a PDF isn't extracted, just
    /// copied in and served verbatim).
    var currentPdfDir: URL? {
        get { lock.lock(); defer { lock.unlock() }; return pdfDir }
        set { lock.lock(); pdfDir = newValue; lock.unlock() }
    }
}
