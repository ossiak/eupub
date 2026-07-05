# Keep the JS bridge methods reachable from WebView reflection.
-keepclassmembers class com.euspell.eupub.** {
    @android.webkit.JavascriptInterface <methods>;
}
