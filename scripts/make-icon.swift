// Generates a simple placeholder icon set for an app: an SF Symbol glyph on a two-colour gradient.
// Usage: swift scripts/make-icon.swift --symbol wind --c1 0288D1 --c2 5BD0F5 [--glyph FFFFFF] [--out <app folder>]
//   --symbol  SF Symbol name (see the SF Symbols app, or `bolt.fill`, `eye`, ...)
//   --c1/--c2 gradient colours as hex RRGGBB (top-left -> bottom-right)
//   --glyph   glyph colour, default FFFFFF      --out  app root, default current folder
// Writes (relative to --out): assets/images/{icon,favicon,splash-icon,android-icon-foreground,
// android-icon-background,android-icon-monochrome}.png and assets/expo.icon/{icon.json,Assets/glyph.png}.
// Placeholder artwork for the owner to replace later. Plain CoreGraphics + AppKit symbols, no dependencies.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

var opts: [String: String] = [:]
var i = 1
let args = CommandLine.arguments
while i + 1 < args.count, args[i].hasPrefix("--") { opts[String(args[i].dropFirst(2))] = args[i + 1]; i += 2 }
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
guard let symbolName = opts["symbol"], let c1s = opts["c1"], let c2s = opts["c2"] else {
  fail("Usage: swift scripts/make-icon.swift --symbol <sf-symbol> --c1 RRGGBB --c2 RRGGBB [--glyph RRGGBB] [--out <app folder>]")
}
func hex(_ s: String) -> UInt32 {
  guard let v = UInt32(s.replacingOccurrences(of: "#", with: ""), radix: 16) else { fail("bad colour \(s)") }
  return v
}
let c1 = hex(c1s), c2 = hex(c2s), glyphHex = hex(opts["glyph"] ?? "FFFFFF")
let root = URL(fileURLWithPath: opts["out"] ?? FileManager.default.currentDirectoryPath)
let images = root.appendingPathComponent("assets/images")
let bundle = root.appendingPathComponent("assets/expo.icon")
let iconAssets = bundle.appendingPathComponent("Assets")
try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: iconAssets, withIntermediateDirectories: true)
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ h: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: space, components: [CGFloat((h >> 16) & 255) / 255, CGFloat((h >> 8) & 255) / 255, CGFloat(h & 255) / 255, a])!
}

/// Square canvas, top-left origin. `opaque` = no alpha channel (the iOS store icon must have none).
func canvas(_ size: Int, opaque: Bool = false) -> CGContext {
  let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)!
  ctx.translateBy(x: 0, y: CGFloat(size))
  ctx.scaleBy(x: 1, y: -1)
  return ctx
}

func save(_ ctx: CGContext, _ url: URL) {
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  guard CGImageDestinationFinalize(dest) else { fail("could not write \(url.path)") }
  print("wrote \(url.path.replacingOccurrences(of: root.path + "/", with: ""))")
}

func resized(_ ctx: CGContext, to size: Int) -> CGContext {
  let out = canvas(size)
  out.interpolationQuality = .high
  out.translateBy(x: 0, y: CGFloat(size))
  out.scaleBy(x: 1, y: -1)
  out.draw(ctx.makeImage()!, in: CGRect(x: 0, y: 0, width: size, height: size))
  return out
}

func background(_ ctx: CGContext, _ size: CGFloat) {
  let g = CGGradient(colorsSpace: space, colors: [rgb(c1), rgb(c2)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: size, y: size), options: [])
}

// The symbol as an alpha-only mask (rendered once, large).
let symbolMask: (mask: CGImage, aspect: CGFloat) = {
  let config = NSImage.SymbolConfiguration(pointSize: 800, weight: .semibold)
  guard let base = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil),
        let img = base.withSymbolConfiguration(config),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("unknown SF Symbol: \(symbolName)") }
  let w = cg.width, h = cg.height
  let m = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue)!
  m.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  return (m.makeImage()!, CGFloat(w) / CGFloat(h))
}()

enum Look { case colour, mono }

/// Draws the symbol centred; `fraction` = share of the canvas its longer side may use.
func glyph(_ ctx: CGContext, canvasSize: CGFloat, fraction: CGFloat, _ look: Look) {
  let box = canvasSize * fraction
  let aspect = symbolMask.aspect
  let w = aspect >= 1 ? box : box * aspect, h = aspect >= 1 ? box / aspect : box
  ctx.saveGState()
  ctx.translateBy(x: canvasSize / 2, y: canvasSize / 2)
  ctx.scaleBy(x: 1, y: -1)  // back to a bottom-left origin so the mask is not mirrored
  let rect = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)
  if look == .colour {
    ctx.setShadow(offset: CGSize(width: 0, height: -canvasSize * 0.012), blur: canvasSize * 0.035, color: rgb(0x000000, 0.3))
  }
  ctx.clip(to: rect, mask: symbolMask.mask)
  ctx.setFillColor(look == .colour ? rgb(glyphHex) : rgb(0xFFFFFF))
  ctx.fill(rect)
  ctx.restoreGState()
}

// iOS / store icon: opaque, full bleed (iOS rounds the corners itself).
do {
  let ctx = canvas(1024, opaque: true)
  background(ctx, 1024)
  glyph(ctx, canvasSize: 1024, fraction: 0.60, .colour)
  save(ctx, images.appendingPathComponent("icon.png"))
  save(resized(ctx, to: 48), images.appendingPathComponent("favicon.png"))
}

// Android adaptive layers: 108 dp canvas, 66 % safe zone (a circular mask keeps ~660 px), so the glyph box is 0.42.
do {
  let fg = canvas(1024)
  glyph(fg, canvasSize: 1024, fraction: 0.42, .colour)
  save(fg, images.appendingPathComponent("android-icon-foreground.png"))
  let bg = canvas(1024, opaque: true)
  background(bg, 1024)
  save(bg, images.appendingPathComponent("android-icon-background.png"))
  let mono = canvas(1024)
  glyph(mono, canvasSize: 1024, fraction: 0.42, .mono)
  save(mono, images.appendingPathComponent("android-icon-monochrome.png"))
}

// Splash: the glyph alone on transparent; the splash colour is set in app.config.ts (use --c1 / the gradient start).
do {
  let ctx = canvas(1024)
  glyph(ctx, canvasSize: 1024, fraction: 0.9, .colour)
  save(ctx, images.appendingPathComponent("splash-icon.png"))
}

// iOS Icon Composer bundle (app.config.ts ios.icon): one transparent glyph layer over a fill; replaces the template's layers.
do {
  let ctx = canvas(1024)
  glyph(ctx, canvasSize: 1024, fraction: 0.60, .colour)
  save(ctx, iconAssets.appendingPathComponent("glyph.png"))
  func comp(_ shift: UInt32) -> String {
    let mid = (Double((c1 >> shift) & 255) + Double((c2 >> shift) & 255)) / 2 / 255
    return String(format: "%.5f", mid)
  }
  let json = """
  {
    "fill" : {
      "automatic-gradient" : "extended-srgb:\(comp(16)),\(comp(8)),\(comp(0)),1.00000"
    },
    "groups" : [
      {
        "layers" : [
          {
            "image-name" : "glyph.png",
            "name" : "glyph"
          }
        ],
        "shadow" : {
          "kind" : "neutral",
          "opacity" : 0.5
        },
        "translucency" : {
          "enabled" : true,
          "value" : 0.5
        }
      }
    ],
    "supported-platforms" : {
      "circles" : [
        "watchOS"
      ],
      "squares" : "shared"
    }
  }

  """
  try json.write(to: bundle.appendingPathComponent("icon.json"), atomically: true, encoding: .utf8)
  print("wrote assets/expo.icon/icon.json")
}
