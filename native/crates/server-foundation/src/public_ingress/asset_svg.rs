//! XML-parser based SVG sanitizer. DTD/entity declarations are never evaluated.
//! Only SVG elements/attributes survive; namespace tricks cannot introduce HTML.
use xmlparser::{ElementEnd, Token, Tokenizer};
const ELEMENTS: &str = "svg style g defs symbol use image switch a title desc metadata path rect circle ellipse line polyline polygon text tspan textPath marker pattern mask clipPath linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence";
const ATTRIBUTES: &str = "id class style version viewBox width height x y x1 y1 x2 y2 dx dy cx cy r rx ry d points transform preserveAspectRatio fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity color display visibility font-family font-size font-style font-weight text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing textLength lengthAdjust startOffset offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform maskUnits maskContentUnits clipPathUnits clip-path clip-rule mask filter filterUnits primitiveUnits in in2 result type values operator k1 k2 k3 k4 mode stdDeviation edgeMode kernelMatrix kernelUnitLength order divisor bias targetX targetY preserveAlpha surfaceScale diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation scale xChannelSelector yChannelSelector flood-color flood-opacity lighting-color numOctaves seed stitchTiles baseFrequency tableValues slope intercept amplitude exponent marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient overflow shape-rendering text-rendering image-rendering vector-effect paint-order color-interpolation color-interpolation-filters pathLength baseline-shift text-decoration font-stretch font-variant role aria-label aria-hidden focusable";
struct Element {
    prefix: String,
    name: String,
    keep: bool,
    attrs: Vec<String>,
}

pub(super) fn sanitize(input: &[u8]) -> Option<Vec<u8>> {
    let raw = std::str::from_utf8(input).ok()?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut output = String::new();
    let mut stack: Vec<Element> = Vec::new();
    let mut pending: Option<Element> = None;
    let mut root = false;
    let mut style_text = String::new();
    for token in Tokenizer::from(raw) {
        match token.ok()? {
            Token::ElementStart { prefix, local, .. } => {
                if pending.is_some()
                    || stack.len() > 256
                    || stack.last().is_some_and(|el| el.keep && el.name == "style")
                {
                    return None;
                }
                if stack.is_empty() {
                    if root || local.as_str() != "svg" || !prefix.is_empty() {
                        return None;
                    }
                    root = true;
                }
                let keep = stack.last().is_none_or(|el| el.keep)
                    && prefix.is_empty()
                    && ELEMENTS.split_whitespace().any(|tag| tag == local.as_str());
                pending = Some(Element {
                    prefix: prefix.as_str().into(),
                    name: local.as_str().into(),
                    keep,
                    attrs: Vec::new(),
                });
                if keep {
                    output.push('<');
                    output.push_str(local.as_str());
                }
            }
            Token::Attribute {
                prefix,
                local,
                value,
                ..
            } => {
                let el = pending.as_mut()?;
                let name = if prefix.is_empty() {
                    local.as_str().to_owned()
                } else {
                    format!("{}:{}", prefix.as_str(), local.as_str())
                };
                if el.attrs.contains(&name) {
                    return None;
                }
                el.attrs.push(name.clone());
                let decoded = decode(value.as_str())?;
                let allowed = match name.as_str() {
                    "xmlns" => decoded == "http://www.w3.org/2000/svg",
                    "xmlns:xlink" => decoded == "http://www.w3.org/1999/xlink",
                    "href" | "xlink:href" => {
                        decoded.trim().is_empty() || decoded.trim().starts_with('#')
                    }
                    "xml:space" => matches!(decoded.as_str(), "preserve" | "default"),
                    _ => {
                        prefix.is_empty() && ATTRIBUTES.split_whitespace().any(|attr| attr == name)
                    }
                };
                if el.keep && allowed && safe_value(&decoded) {
                    output.push(' ');
                    output.push_str(&name);
                    output.push_str("=\"");
                    escape(&decoded, &mut output);
                    output.push('"');
                }
            }
            Token::ElementEnd { end, .. } => match end {
                ElementEnd::Open => {
                    let el = pending.take()?;
                    if el.keep {
                        output.push('>');
                    }
                    stack.push(el);
                }
                ElementEnd::Empty => {
                    let el = pending.take()?;
                    if el.keep {
                        output.push_str("/>");
                    }
                }
                ElementEnd::Close(prefix, name) => {
                    if pending.is_some() {
                        return None;
                    }
                    let el = stack.pop()?;
                    if el.name != name.as_str() || el.prefix != prefix.as_str() {
                        return None;
                    }
                    if el.keep {
                        if el.name == "style" {
                            if safe_value(&style_text) {
                                escape(&style_text, &mut output);
                            }
                            style_text.clear();
                        }
                        output.push_str("</");
                        output.push_str(&el.name);
                        output.push('>');
                    }
                }
            },
            Token::Text { text } => {
                let decoded = decode(text.as_str())?;
                if stack.is_empty() && !decoded.trim().is_empty() {
                    return None;
                }
                if let Some(el) = stack.last().filter(|el| el.keep) {
                    if el.name == "style" {
                        style_text.push_str(&decoded);
                    } else {
                        escape(&decoded, &mut output);
                    }
                }
            }
            Token::Cdata { text, .. } => {
                if let Some(el) = stack.last().filter(|el| el.keep) {
                    if el.name == "style" {
                        style_text.push_str(text.as_str());
                    } else {
                        escape(text.as_str(), &mut output);
                    }
                }
            }
            Token::Comment { .. } | Token::Declaration { .. } => {}
            // Reject DTDs (including external entities), processing instructions,
            // and any future token rather than accidentally preserving active XML.
            _ => return None,
        }
    }
    (root && stack.is_empty() && pending.is_none()).then(|| output.into_bytes())
}
fn safe_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("javascript:")
        || lower.contains("expression")
        || lower.contains('@')
        || lower.contains('\\')
    {
        return false;
    }
    let mut tail = lower.as_str();
    while let Some((_, after)) = tail.split_once("url(") {
        let Some((url, rest)) = after.split_once(')') else {
            return false;
        };
        if !url.trim().trim_matches(['\'', '"']).starts_with('#') {
            return false;
        }
        tail = rest;
    }
    true
}
fn escape(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
}
fn decode(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut tail = value;
    while let Some((before, after)) = tail.split_once('&') {
        output.push_str(before);
        let (entity, rest) = after.split_once(';')?;
        let ch = match entity {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let num = if let Some(hex) = entity.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()?
                } else {
                    entity.strip_prefix('#')?.parse().ok()?
                };
                char::from_u32(num)?
            }
        };
        if !matches!(ch, '\t' | '\r' | '\n') && (ch < ' ' || matches!(ch, '\u{fffe}' | '\u{ffff}'))
        {
            return None;
        }
        output.push(ch);
        tail = rest;
    }
    output.push_str(tail);
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_active_svg_and_preserves_vectors_filters_and_fragment_references() {
        let result = sanitize(br##"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><defs><linearGradient id="g"><stop offset="1" stop-color="red"/></linearGradient></defs><style>.cls { fill: red; }</style><path class="cls" fill="url(#g)" d="M0 0"/><use href="#g"/><image href="&#x6a;avascript:alert(1)"/><g style="fill:red" onclick="x"/><a href="https://evil.test"/></svg>"##).unwrap();
        let output = String::from_utf8(result).unwrap();
        assert!(output.contains("<style>.cls { fill: red; }</style>"));
        assert!(output.contains("linearGradient"));
        assert!(output.contains("url(#g)"));
        assert!(output.contains("href=\"#g\""));
        assert!(output.contains("style=\"fill:red\""));
        for banned in [
            "script",
            "foreignObject",
            "onload",
            "onclick",
            "javascript",
            "https://evil",
        ] {
            assert!(!output.contains(banned), "{output}");
        }
    }
    #[test]
    fn rejects_malformed_xml_entities_namespaces_and_declarations() {
        for input in [
            "<svg><g></svg>",
            "<svg/><svg/>",
            "<html/>",
            "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg>&x;</svg>",
            "<svg a='1' a='2'/>",
            "<svg>&bogus;</svg>",
        ] {
            assert!(sanitize(input.as_bytes()).is_none(), "{input}");
        }
        let sanitized = sanitize(br#"<svg><evil:script xmlns:evil="http://www.w3.org/1999/xhtml">bad</evil:script><path fill="url(https://evil)"/></svg>"#).unwrap();
        assert_eq!(String::from_utf8(sanitized).unwrap(), "<svg><path/></svg>");
    }
}
