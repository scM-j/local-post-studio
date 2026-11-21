import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: generate_icon.swift <output.iconset>\n", stderr)
    exit(1)
}

let iconsetPath = CommandLine.arguments[1]
let fm = FileManager.default
try? fm.removeItem(atPath: iconsetPath)
try! fm.createDirectory(atPath: iconsetPath, withIntermediateDirectories: true)

func renderIcon(size: Int) -> Data {
    let s = CGFloat(size)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!

    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)

    // macOS Big Sur/Sequoia squircle bounds (824/1024 inset)
    let pad = s * 0.095
    let rect = CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    let radius = rect.width * 0.225
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

    // Drop shadow
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.015), blur: s * 0.04, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.45))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(red: 0.09, green: 0.10, blue: 0.13, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    // Clip to squircle
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()

    // Deep studio obsidian-indigo gradient background
    let bgColors = [
        CGColor(red: 0.16, green: 0.18, blue: 0.23, alpha: 1.0),
        CGColor(red: 0.09, green: 0.10, blue: 0.13, alpha: 1.0),
        CGColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0),
    ] as CFArray
    let bgGrad = CGGradient(colorsSpace: colorSpace, colors: bgColors, locations: [0.0, 0.55, 1.0])!
    ctx.drawLinearGradient(bgGrad, start: CGPoint(x: s * 0.5, y: rect.maxY), end: CGPoint(x: s * 0.5, y: rect.minY), options: [])

    // Subtle radial Pro-Blue glow behind lens
    let glowColors = [
        CGColor(red: 0.04, green: 0.52, blue: 1.0, alpha: 0.34),
        CGColor(red: 0.37, green: 0.36, blue: 0.90, alpha: 0.12),
        CGColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0),
    ] as CFArray
    let glow = CGGradient(colorsSpace: colorSpace, colors: glowColors, locations: [0.0, 0.48, 1.0])!
    let center = CGPoint(x: s * 0.5, y: s * 0.52)
    ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: s * 0.40, options: [])

    // Outer technical ring
    let outerR = s * 0.275
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.18))
    ctx.setLineWidth(max(1, s * 0.014))
    ctx.strokeEllipse(in: CGRect(x: center.x - outerR, y: center.y - outerR, width: outerR * 2, height: outerR * 2))

    // Pro cinema aperture diamond / prism emblem
    let innerR = s * 0.175
    ctx.saveGState()
    ctx.translateBy(x: center.x, y: center.y)
    ctx.rotate(by: .pi / 4)
    let prismRect = CGRect(x: -innerR * 0.72, y: -innerR * 0.72, width: innerR * 1.44, height: innerR * 1.44)
    let prismPath = CGPath(roundedRect: prismRect, cornerWidth: innerR * 0.24, cornerHeight: innerR * 0.24, transform: nil)
    ctx.addPath(prismPath)
    ctx.clip()
    let prismColors = [
        CGColor(red: 0.22, green: 0.65, blue: 1.0, alpha: 1.0),
        CGColor(red: 0.04, green: 0.45, blue: 0.96, alpha: 1.0),
        CGColor(red: 0.37, green: 0.36, blue: 0.90, alpha: 1.0),
    ] as CFArray
    let prismGrad = CGGradient(colorsSpace: colorSpace, colors: prismColors, locations: [0.0, 0.55, 1.0])!
    ctx.drawLinearGradient(prismGrad, start: CGPoint(x: -innerR, y: innerR), end: CGPoint(x: innerR, y: -innerR), options: [])
    ctx.restoreGState()

    // Inner lens core highlight
    let coreR = s * 0.056
    ctx.setFillColor(CGColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 0.92))
    ctx.fillEllipse(in: CGRect(x: center.x - coreR, y: center.y - coreR, width: coreR * 2, height: coreR * 2))
    let dotR = s * 0.022
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.92))
    ctx.fillEllipse(in: CGRect(x: center.x - dotR, y: center.y - dotR, width: dotR * 2, height: dotR * 2))

    // Bottom subtle color-grading spectrum pill (Rec.709 / Log / HDR motif)
    let barW = s * 0.42
    let barH = max(2, s * 0.026)
    let barRect = CGRect(x: (s - barW) / 2, y: rect.minY + s * 0.095, width: barW, height: barH)
    let barPath = CGPath(roundedRect: barRect, cornerWidth: barH / 2, cornerHeight: barH / 2, transform: nil)
    ctx.saveGState()
    ctx.addPath(barPath)
    ctx.clip()
    let specColors = [
        CGColor(red: 0.96, green: 0.38, blue: 0.34, alpha: 0.95),
        CGColor(red: 0.96, green: 0.65, blue: 0.14, alpha: 0.95),
        CGColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 0.95),
        CGColor(red: 0.04, green: 0.52, blue: 1.00, alpha: 0.95),
    ] as CFArray
    let specGrad = CGGradient(colorsSpace: colorSpace, colors: specColors, locations: [0.0, 0.35, 0.68, 1.0])!
    ctx.drawLinearGradient(specGrad, start: CGPoint(x: barRect.minX, y: barRect.midY), end: CGPoint(x: barRect.maxX, y: barRect.midY), options: [])
    ctx.restoreGState()

    // Specular inner rim highlight
    ctx.addPath(path)
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.16))
    ctx.setLineWidth(max(1, s * 0.012))
    ctx.strokePath()

    ctx.restoreGState()

    let image = ctx.makeImage()!
    let rep = NSBitmapImageRep(cgImage: image)
    return rep.representation(using: .png, properties: [:])!
}

let specs: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, px) in specs {
    let data = renderIcon(size: px)
    try! data.write(to: URL(fileURLWithPath: iconsetPath).appendingPathComponent(name))
}
