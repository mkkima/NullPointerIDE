NullPointer Portable for Windows x64
===================================

Run NullPointer.exe directly. No installation is required.

The data folder is created next to the executable and contains WebView2 data,
preferences, cache, and saved Research drafts. Keep portable.flag next to the
executable; removing it switches the application back to the standard data
location under the Windows user profile.

Portable builds do not self-install updates because the running executable
cannot safely replace its own folder. Download the newest portable ZIP from:

https://github.com/mkkima/NullPointerIDE/releases/latest

Close NullPointer, extract the new ZIP, and replace the old application files.
Keep the existing data folder if you want to preserve preferences and drafts.

Windows 10/11 must have the Microsoft Edge WebView2 Runtime installed. It is
normally included with current Windows versions.
