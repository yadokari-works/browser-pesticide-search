import SwiftUI
import WebKit

struct ContentView: View {
    @State private var showingGuide = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            WebView(resourceName: "これをクリック", ext: "html")
                .edgesIgnoringSafeArea(.all)

            // 右上に「使い方」ボタン
            Button(action: { showingGuide = true }) {
                Text("使い方")
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(red: 0.15, green: 0.64, blue: 0.29))
                    .foregroundColor(.white)
                    .cornerRadius(14)
            }
            .padding(.top, 8)
            .padding(.trailing, 12)
        }
        .sheet(isPresented: $showingGuide) {
            GuideSheet(isPresented: $showingGuide)
        }
    }
}

struct GuideSheet: View {
    @Binding var isPresented: Bool

    var body: some View {
        NavigationView {
            WebView(resourceName: "使い方", ext: "html")
                .navigationTitle("使い方")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("閉じる") { isPresented = false }
                    }
                }
        }
    }
}

/// ローカル HTML を表示する WKWebView ラッパー。
/// 外部リンク (JPP-NET 等) は Safari に委譲する。
struct WebView: UIViewRepresentable {
    let resourceName: String
    let ext: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.preferences.javaScriptEnabled = true
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.allowsInlineMediaPlayback = true

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.scrollView.bounces = true
        web.scrollView.contentInsetAdjustmentBehavior = .always
        loadBundled(web)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private func loadBundled(_ web: WKWebView) {
        guard let url = Bundle.main.url(forResource: resourceName, withExtension: ext) else {
            // リソースが見つからない場合のフォールバック
            let html = "<h2>\(resourceName).\(ext) がアプリ同梱リソースに含まれていません。</h2>"
            web.loadHTMLString(html, baseURL: nil)
            return
        }
        // Bundle ディレクトリをまるごと読み取り可能に
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    /// 外部リンクを Safari で開く
    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView,
                     decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else {
                decisionHandler(.allow); return
            }
            // file:// 以内はアプリ内で表示、https:// 等は外部ブラウザへ
            if url.isFileURL || action.navigationType == .other {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }
    }
}
