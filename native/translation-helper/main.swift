// MacTranslate translation helper.
//
// Bridges the Electron app to Apple's on-device Translation framework and
// auto-translates Chinese <-> English.
//
// One-shot mode (default): read {"items":[{"id","text"}]} from stdin until EOF,
// write one JSON envelope line to stdout, exit. Works on macOS 15+ by hosting a
// SwiftUI translationTask in an invisible window.
//
// Server mode (--server): read one {"requestId","items"} JSON request per stdin
// line and answer each with one JSON line. Needs macOS 26 (sessions without
// SwiftUI); older systems answer every request with
// MACTRANSLATE_PERSISTENT_SERVER_REQUIRES_MACOS_26 so the app falls back to
// one-shot runs.

import AppKit
import Foundation
import NaturalLanguage
import SwiftUI
import Translation

let engineName = "macOS Translation"
let persistentServerUnavailable = "MACTRANSLATE_PERSISTENT_SERVER_REQUIRES_MACOS_26"
let chineseTarget = "zh-Hans"
let translationTimeoutNanoseconds: UInt64 = 25_000_000_000

enum TranslationStatus {
  static let ok = "ok"
  static let unsupportedLanguage = "unsupportedLanguage"
  static let unknownAvailability = "unknownAvailability"
  static let translationError = "translationError"
  static let languagePackRequired = "languagePackRequired"
  static let unsupportedPair = "unsupportedPair"
}

enum TranslationMessage {
  static let unsupportedLanguage = "当前只自动处理中英文"
  static let unknownAvailability = "无法确认系统翻译语言包状态"
  static let sessionNotReady = "macOS 系统翻译会话尚未就绪"
  static let languagePackRequired = "请先在 macOS 系统设置中安装中文和英文翻译语言包"
  static let unsupportedPair = "macOS 系统翻译不支持这个语言组合"
  static let timeout = "macOS 系统翻译超时"
}

struct TranslationInput: Decodable {
  let id: String
  let text: String
}

struct TranslationRequestEnvelope: Decodable {
  let requestId: String?
  let items: [TranslationInput]
}

struct TranslationResult: Encodable {
  let id: String
  let originalText: String
  var translatedText: String?
  var sourceLanguage: String?
  var targetLanguage: String?
  var status: String
  var message: String?
}

struct TranslationOutputEnvelope: Encodable {
  var requestId: String?
  let ok: Bool
  let engine: String
  let results: [TranslationResult]
  var message: String?
}

struct LanguagePair: Hashable {
  let source: String
  let target: String
}

struct TranslationTimeout: Error {}

// MARK: - Language detection

/// Any Han character makes the text Chinese (mixed "我明天要去 meeting" is
/// Chinese). Otherwise the recognizer, limited to English and Chinese, decides;
/// text it cannot place (Korean, Russian, emoji, digits) is left alone.
func detectPair(for text: String) -> LanguagePair? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let recognizer = NLLanguageRecognizer()
  if trimmed.unicodeScalars.contains(where: isHan) {
    recognizer.languageConstraints = [.simplifiedChinese, .traditionalChinese]
    recognizer.processString(trimmed)
    let source = recognizer.dominantLanguage == .traditionalChinese ? "zh-Hant" : "zh-Hans"
    return LanguagePair(source: source, target: "en")
  }
  recognizer.languageConstraints = [.english, .simplifiedChinese, .traditionalChinese]
  recognizer.processString(trimmed)
  switch recognizer.dominantLanguage {
  case .english?:
    return LanguagePair(source: "en", target: chineseTarget)
  case .simplifiedChinese?:
    return LanguagePair(source: "zh-Hans", target: "en")
  case .traditionalChinese?:
    return LanguagePair(source: "zh-Hant", target: "en")
  default:
    return nil
  }
}

func isHan(_ scalar: Unicode.Scalar) -> Bool {
  switch scalar.value {
  case 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF:
    return true
  default:
    return false
  }
}

// MARK: - Output

func writeLine<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  guard var data = try? encoder.encode(value) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

// MARK: - Translation backends

@MainActor
protocol TranslationBackend: AnyObject {
  func translate(
    pair: LanguagePair,
    requests: [TranslationSession.Request]
  ) async throws -> [TranslationSession.Response]
}

/// macOS 15+: sessions only come from SwiftUI's translationTask, so an
/// invisible window hosts a view whose configuration is switched per pair.
@MainActor
final class PersistentTranslationCoordinator: ObservableObject, TranslationBackend {
  private struct Job {
    let pair: LanguagePair
    let requests: [TranslationSession.Request]
    let continuation: CheckedContinuation<[TranslationSession.Response], Error>
  }

  @Published var configuration: TranslationSession.Configuration?
  private var queue: [Job] = []
  private var current: Job?
  private var currentToken = 0

  func translate(
    pair: LanguagePair,
    requests: [TranslationSession.Request]
  ) async throws -> [TranslationSession.Response] {
    try await withCheckedThrowingContinuation { continuation in
      queue.append(Job(pair: pair, requests: requests, continuation: continuation))
      startNextIfIdle()
    }
  }

  private func startNextIfIdle() {
    guard current == nil, !queue.isEmpty else { return }
    let job = queue.removeFirst()
    current = job
    currentToken += 1
    let token = currentToken
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: translationTimeoutNanoseconds)
      self.finish(token: token, result: .failure(TranslationTimeout()))
    }
    let next = TranslationSession.Configuration(
      source: Locale.Language(identifier: job.pair.source),
      target: Locale.Language(identifier: job.pair.target)
    )
    if configuration == next {
      configuration?.invalidate()
    } else {
      configuration = next
    }
  }

  func run(session: TranslationSession) async {
    guard let job = current else { return }
    let token = currentToken
    do {
      let responses = try await session.translations(from: job.requests)
      finish(token: token, result: .success(responses))
    } catch {
      finish(token: token, result: .failure(error))
    }
  }

  private func finish(token: Int, result: Result<[TranslationSession.Response], Error>) {
    guard token == currentToken, let job = current else { return }
    current = nil
    job.continuation.resume(with: result)
    startNextIfIdle()
  }
}

struct PersistentTranslationRootView: View {
  @ObservedObject var coordinator: PersistentTranslationCoordinator

  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(coordinator.configuration) { session in
        await coordinator.run(session: session)
      }
  }
}

/// macOS 26+: sessions for installed languages can be created directly.
@available(macOS 26.0, *)
@MainActor
final class InstalledSessionBackend: TranslationBackend {
  private var sessions: [LanguagePair: TranslationSession] = [:]

  func translate(
    pair: LanguagePair,
    requests: [TranslationSession.Request]
  ) async throws -> [TranslationSession.Response] {
    let session: TranslationSession
    if let cached = sessions[pair] {
      session = cached
    } else {
      session = TranslationSession(
        installedSource: Locale.Language(identifier: pair.source),
        target: Locale.Language(identifier: pair.target)
      )
      sessions[pair] = session
    }
    return try await withTimeout { try await session.translations(from: requests) }
  }
}

@MainActor
func withTimeout<T>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { @MainActor in try await operation() }
    group.addTask {
      try await Task.sleep(nanoseconds: translationTimeoutNanoseconds)
      throw TranslationTimeout()
    }
    defer { group.cancelAll() }
    guard let first = try await group.next() else { throw TranslationTimeout() }
    return first
  }
}

// MARK: - Request processing

/// Pairs this process has already confirmed as not installed.
@MainActor var confirmedMissingPairs: [LanguagePair: Date] = [:]
let coldStartRecheckAttempts = 10
let coldStartRecheckIntervalNanoseconds: UInt64 = 500_000_000
let confirmedMissingTTL: TimeInterval = 30

/// Right after translationd (re)starts, LanguageAvailability reports installed
/// pairs as `.supported` for 1-3 s. Re-check for up to 5 s before telling the
/// user to download a language pack; remember a confirmed miss for 30 s so
/// genuinely missing packs are not re-waited on every request.
@MainActor
func installedStatus(for pair: LanguagePair) async -> LanguageAvailability.Status {
  let availability = LanguageAvailability()
  let source = Locale.Language(identifier: pair.source)
  let target = Locale.Language(identifier: pair.target)
  var status = await availability.status(from: source, to: target)
  if status != .supported { return status }
  if let confirmed = confirmedMissingPairs[pair], Date().timeIntervalSince(confirmed) < confirmedMissingTTL {
    return status
  }
  for _ in 0..<coldStartRecheckAttempts {
    try? await Task.sleep(nanoseconds: coldStartRecheckIntervalNanoseconds)
    status = await availability.status(from: source, to: target)
    if status != .supported { return status }
  }
  confirmedMissingPairs[pair] = Date()
  return status
}

@MainActor
func translateItems(
  _ items: [TranslationInput],
  backend: TranslationBackend
) async -> [TranslationResult] {
  var results = items.map { TranslationResult(id: $0.id, originalText: $0.text, status: TranslationStatus.translationError) }
  var groups: [LanguagePair: [Int]] = [:]
  var order: [LanguagePair] = []

  for (index, item) in items.enumerated() {
    guard let pair = detectPair(for: item.text) else {
      results[index].status = TranslationStatus.unsupportedLanguage
      results[index].message = TranslationMessage.unsupportedLanguage
      continue
    }
    results[index].sourceLanguage = pair.source
    results[index].targetLanguage = pair.target
    if groups[pair] == nil { order.append(pair) }
    groups[pair, default: []].append(index)
  }

  for pair in order {
    let indexes = groups[pair] ?? []
    let status = await installedStatus(for: pair)
    let failure: (String, String)?
    switch status {
    case .installed:
      failure = nil
    case .supported:
      failure = (TranslationStatus.languagePackRequired, TranslationMessage.languagePackRequired)
    case .unsupported:
      failure = (TranslationStatus.unsupportedPair, TranslationMessage.unsupportedPair)
    @unknown default:
      failure = (TranslationStatus.unknownAvailability, TranslationMessage.unknownAvailability)
    }
    if let (failedStatus, message) = failure {
      for index in indexes {
        results[index].status = failedStatus
        results[index].message = message
      }
      continue
    }

    let requests = indexes.map {
      TranslationSession.Request(sourceText: items[$0].text, clientIdentifier: String($0))
    }
    do {
      let responses = try await backend.translate(pair: pair, requests: requests)
      var byIndex: [Int: String] = [:]
      for response in responses {
        if let identifier = response.clientIdentifier, let index = Int(identifier) {
          byIndex[index] = response.targetText
        }
      }
      for index in indexes {
        if let translated = byIndex[index] {
          results[index].status = TranslationStatus.ok
          results[index].translatedText = translated
        } else {
          results[index].status = TranslationStatus.translationError
          results[index].message = TranslationMessage.sessionNotReady
        }
      }
    } catch is TranslationTimeout {
      for index in indexes {
        results[index].status = TranslationStatus.translationError
        results[index].message = TranslationMessage.timeout
      }
    } catch {
      for index in indexes {
        results[index].status = TranslationStatus.translationError
        results[index].message = String(describing: error)
      }
    }
  }
  return results
}

// MARK: - App host

final class TranslationHostAppDelegate: NSObject, NSApplicationDelegate {
  let serverMode: Bool
  var initialInput: Data?
  var window: NSWindow?
  var didStart = false
  @MainActor lazy var coordinator = PersistentTranslationCoordinator()

  init(serverMode: Bool) {
    self.serverMode = serverMode
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard !didStart else { return }
    didStart = true
    MainActor.assumeIsolated {
      if serverMode {
        startServer()
      } else {
        startHostWindow()
        startOneShot()
      }
    }
  }

  @MainActor
  private func startHostWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: -10_000, y: -10_000, width: 1, height: 1),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: PersistentTranslationRootView(coordinator: coordinator))
    window.orderFront(nil)
    self.window = window
  }

  @MainActor
  private func startOneShot() {
    Task.detached {
      let data = FileHandle.standardInput.readDataToEndOfFile()
      await MainActor.run { self.initialInput = data }
      let envelope: TranslationOutputEnvelope
      do {
        let request = try JSONDecoder().decode(TranslationRequestEnvelope.self, from: data)
        let results = await translateItems(request.items, backend: self.coordinator)
        envelope = TranslationOutputEnvelope(ok: true, engine: engineName, results: results)
      } catch {
        envelope = TranslationOutputEnvelope(ok: false, engine: engineName, results: [], message: String(describing: error))
      }
      writeLine(envelope)
      await MainActor.run { NSApplication.shared.terminate(nil) }
    }
  }

  @MainActor
  private func startServer() {
    let lines = AsyncStream<String> { continuation in
      Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
          continuation.yield(line)
        }
        continuation.finish()
      }
    }
    Task { @MainActor in
      if #available(macOS 26.0, *) {
        let backend = InstalledSessionBackend()
        for await line in lines {
          Task { @MainActor in
            await self.answer(line: line) { items in
              let results = await translateItems(items, backend: backend)
              return TranslationOutputEnvelope(ok: true, engine: engineName, results: results)
            }
          }
        }
      } else {
        for await line in lines {
          await self.answer(line: line) { _ in
            TranslationOutputEnvelope(ok: false, engine: engineName, results: [], message: persistentServerUnavailable)
          }
        }
      }
      // stdin closed: the app went away, so quit without waiting for answers.
      NSApplication.shared.terminate(nil)
    }
  }

  @MainActor
  private func answer(
    line: String,
    handler: @escaping @MainActor ([TranslationInput]) async -> TranslationOutputEnvelope
  ) async {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    do {
      let request = try JSONDecoder().decode(TranslationRequestEnvelope.self, from: Data(trimmed.utf8))
      var envelope = await handler(request.items)
      envelope.requestId = request.requestId
      writeLine(envelope)
    } catch {
      writeLine(TranslationOutputEnvelope(ok: false, engine: engineName, results: [], message: String(describing: error)))
    }
  }
}

let serverMode = CommandLine.arguments.dropFirst().contains("--server")
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let delegate = TranslationHostAppDelegate(serverMode: serverMode)
app.delegate = delegate
app.run()
