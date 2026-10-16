---
'@richardmcquiston01/storage-adapters': minor
---

`fileAdapter` now reports changes made by other processes to its files. While something is subscribed, it watches the directory through the new optional `FileSystemLike.watchDirectory(directory, onChange)` (which `nodeFileSystem()` provides), re-reads the file that changed and tells the subscribers of that key if its value or revision is different. Its own writes are reported once, temporary files and half-written files are ignored, and the watcher stops when the last subscriber leaves. A file system without `watchDirectory` behaves as before. Hearing about another process's write does not make two writers safe; the one-process-per-directory warning stands.
