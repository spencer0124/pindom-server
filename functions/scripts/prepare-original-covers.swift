// Create mobile JPEG covers without modifying the supplied originals.
// xcrun swift prepare-original-covers.swift INPUT_DIRECTORY OUTPUT_DIRECTORY
import Foundation
import ImageIO
import UniformTypeIdentifiers
guard CommandLine.arguments.count == 3 else { fatalError("Pass input and output directories") }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
var total = 0
for file in try FileManager.default.contentsOfDirectory(at: input, includingPropertiesForKeys: nil) where ["jpg", "png"].contains(file.pathExtension.lowercased()) {
  guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1200] as CFDictionary) else { fatalError("Image decode failed") }
  let target = output.appendingPathComponent(file.deletingPathExtension().lastPathComponent).appendingPathExtension("jpg")
  guard let dest = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { fatalError("Cannot encode") }
  CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { fatalError("Encode failed") }
  total += try Data(contentsOf: target).count
}
print("Encoded covers, total bytes: \(total)")
