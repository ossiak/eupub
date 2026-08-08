# Keep the JS bridge methods reachable from WebView reflection.
-keepclassmembers class org.euspell.eupub.** {
    @android.webkit.JavascriptInterface <methods>;
}
