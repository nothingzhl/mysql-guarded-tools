import Foundation
import Security

// Secrets arrive over a pipe, never process arguments. Errors contain only OSStatus.
func run() throws {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try JSONSerialization.jsonObject(with: data) as? [String: String],
          let action = request["action"], let name = request["name"],
          name.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
        throw NSError(domain: "Invalid request", code: 1)
    }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "mysql-readonly-connector",
        kSecAttrAccount as String: "connection:" + name
    ]
    var result: [String: Any] = [:]
    switch action {
    case "get", "exists":
        var match = query
        match[kSecMatchLimit as String] = kSecMatchLimitOne
        match[action == "get" ? kSecReturnData as String : kSecReturnAttributes as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(match as CFDictionary, &item)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: "Keychain", code: Int(status)) }
        if action == "exists" { result["exists"] = status == errSecSuccess }
        else if status == errSecItemNotFound { result["password"] = NSNull() }
        else if let secret = item as? Data, let value = String(data: secret, encoding: .utf8) { result["password"] = value }
        else { throw NSError(domain: "Keychain encoding", code: 2) }
    case "set":
        guard let value = request["password"], !value.isEmpty else { throw NSError(domain: "Empty password", code: 3) }
        let secret = Data(value.utf8)
        let attrs = [kSecValueData as String: secret]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var newItem = query
            newItem[kSecValueData as String] = secret
            newItem[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(newItem as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: "Keychain", code: Int(status)) }
        result["ok"] = true
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: "Keychain", code: Int(status)) }
        result["ok"] = true
    default: throw NSError(domain: "Unknown action", code: 4)
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
}
do { try run() } catch {
    let code = (error as NSError).code
    FileHandle.standardError.write(Data("Keychain operation failed (code \(code))\n".utf8))
    exit(1)
}
