NullPointer Portable for Windows x64
===================================

Run NullPointer.exe directly. No installation is required.

The data folder is created next to the executable and contains WebView2 data,
preferences, cache, and saved Research drafts. Keep portable.flag next to the
executable; removing it switches the application back to the standard data
location under the Windows user profile.

Portable builds check GitHub Releases for signed updates automatically. When an
update is installed, a temporary helper replaces NullPointer.exe after the
application closes, keeps the data folder untouched, starts the new build, and
restores the previous executable if the new build cannot start successfully.

You can also download the newest portable ZIP manually from:

https://github.com/mkkima/NullPointerIDE/releases/latest

For a manual update, close NullPointer, extract the new ZIP, and replace the old
application files. Keep the existing data folder to preserve preferences and
drafts.

Windows 10/11 must have the Microsoft Edge WebView2 Runtime installed. It is
normally included with current Windows versions.
