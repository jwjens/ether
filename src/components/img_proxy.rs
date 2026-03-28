// Add to ether-backend/src/main.rs
//
// Image proxy — fetches external images (iTunes, MusicBrainz) and
// re-serves them with CORS headers so canvas can read pixels.
// This is what enables the iPod silhouette effect.

// Add this route to your Router::new() chain:
// .route("/api/img-proxy", get(img_proxy_handler))

async fn img_proxy_handler(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl axum::response::IntoResponse {
    let url = match params.get("url") {
        Some(u) => u.clone(),
        None => return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::http::HeaderMap::new(),
            axum::body::Bytes::new(),
        ),
    };

    // Only allow known safe domains
    let allowed = ["itunes.apple.com", "is1-ssl.mzstatic.com", "coverartarchive.org",
                   "musicbrainz.org", "i.scdn.co", "lastfm.freetls.fastly.net"];
    let is_allowed = allowed.iter().any(|d| url.contains(d));
    if !is_allowed {
        return (
            axum::http::StatusCode::FORBIDDEN,
            axum::http::HeaderMap::new(),
            axum::body::Bytes::new(),
        );
    }

    // Fetch the image
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Ether/1.5")
        .build()
        .unwrap_or_default();

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (
            axum::http::StatusCode::BAD_GATEWAY,
            axum::http::HeaderMap::new(),
            axum::body::Bytes::new(),
        ),
    };

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return (
            axum::http::StatusCode::BAD_GATEWAY,
            axum::http::HeaderMap::new(),
            axum::body::Bytes::new(),
        ),
    };

    // Build response headers with CORS
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("Access-Control-Allow-Origin",  "*".parse().unwrap());
    headers.insert("Access-Control-Allow-Methods", "GET".parse().unwrap());
    headers.insert("Content-Type", content_type.parse().unwrap_or("image/jpeg".parse().unwrap()));
    headers.insert("Cache-Control", "public, max-age=86400".parse().unwrap()); // cache 24h

    (axum::http::StatusCode::OK, headers, bytes)
}

// Also add reqwest to your Cargo.toml:
// reqwest = { version = "0.12", features = ["json"] }
