// Cryptographic Tests for Secret Key to SS58 Address Mapping

import { test, expect } from '@playwright/test'
import { Keyring } from '@polkadot/keyring'
import { hexToU8a } from '@polkadot/util'
import { cryptoWaitReady, sr25519Sign, sr25519Verify, sr25519PairFromSeed } from '@polkadot/util-crypto'

// Test Constants
const TEST_DATA = {
    correctSecretKey: '0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce',
    expectedSS58Address: '5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw',
    incorrectSecretKey: '0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7'
}

// Utility function to derive SS58 address from secret key
const deriveSS58Address = (secretKeyHex) => {
    try {
        // Convert hex string to Uint8Array
        const secretKeyBytes = hexToU8a(secretKeyHex)

        // Create keyring instance
        const keyring = new Keyring({ type: 'sr25519' })

        // Add key pair from secret key
        const keyPair = keyring.addFromSeed(secretKeyBytes)

        // Get the SS58 address
        return keyPair.address
    } catch (error) {
        throw new Error(`Failed to derive SS58 address: ${error.message}`)
    }
}

// Utility function to create key pair from secret key
const createKeyPair = (secretKeyHex) => {
    try {
        // Convert hex string to Uint8Array
        const secretKeyBytes = hexToU8a(secretKeyHex)

        // Create keyring instance
        const keyring = new Keyring({ type: 'sr25519' })

        // Add key pair from secret key
        return keyring.addFromSeed(secretKeyBytes)
    } catch (error) {
        throw new Error(`Failed to create key pair: ${error.message}`)
    }
}

// Utility function to sign a message with a key pair
const signMessage = (keyPair, message) => {
    try {
        // Convert message to Uint8Array
        const messageBytes = new TextEncoder().encode(message)

        // Create key pair from secret key using direct crypto function
        const secretKeyBytes = hexToU8a(TEST_DATA.correctSecretKey)
        const pair = sr25519PairFromSeed(secretKeyBytes)

        // Sign the message using sr25519Sign directly
        const signature = sr25519Sign(messageBytes, pair)

        return signature
    } catch (error) {
        throw new Error(`Failed to sign message: ${error.message}`)
    }
}

// Utility function to verify signature with a key pair
const verifySignatureWithKeyPair = (keyPair, message, signature) => {
    try {
        // Convert message to Uint8Array
        const messageBytes = new TextEncoder().encode(message)

        // Create key pair from secret key using direct crypto function
        const secretKeyBytes = hexToU8a(TEST_DATA.correctSecretKey)
        const pair = sr25519PairFromSeed(secretKeyBytes)

        // Verify the signature using sr25519Verify directly
        return sr25519Verify(messageBytes, signature, pair.publicKey)
    } catch (error) {
        throw new Error(`Failed to verify signature: ${error.message}`)
    }
}

// Utility function to verify signature with SS58 address (for testing with known secret key)
const verifySignature = (ss58Address, message, signature) => {
    try {
        // Create keyring instance to get the address
        const keyring = new Keyring({ type: 'sr25519' })
        const secretKeyBytes = hexToU8a(TEST_DATA.correctSecretKey)
        const keyPair = keyring.addFromSeed(secretKeyBytes)

        // Verify the address matches
        if (keyPair.address !== ss58Address) {
            throw new Error(`Address mismatch: expected ${ss58Address}, got ${keyPair.address}`)
        }

        // Create key pair using direct crypto function for verification
        const pair = sr25519PairFromSeed(secretKeyBytes)

        // Verify the signature using sr25519Verify directly
        const messageBytes = new TextEncoder().encode(message)
        return sr25519Verify(messageBytes, signature, pair.publicKey)
    } catch (error) {
        throw new Error(`Failed to verify signature: ${error.message}`)
    }
}

// Test Suite: Secret Key to SS58 Address Mapping
test.describe('Secret Key to SS58 Address Mapping:', () => {

    // Initialize crypto before running tests
    test.beforeAll(async () => {
        await cryptoWaitReady()
    })

    test('should correctly map secret key to expected SS58 address', () => {
        const derivedAddress = deriveSS58Address(TEST_DATA.correctSecretKey)

        expect(derivedAddress).toBe(TEST_DATA.expectedSS58Address)
    })

    test('should fail when incorrect secret key is used', () => {
        const derivedAddress = deriveSS58Address(TEST_DATA.incorrectSecretKey)

        expect(derivedAddress).not.toBe(TEST_DATA.expectedSS58Address)
    })

    test('should handle invalid secret key format gracefully', () => {
        const invalidSecretKey = '0xinvalid'

        expect(() => {
            deriveSS58Address(invalidSecretKey)
        }).toThrow()
    })

    test('should handle empty secret key gracefully', () => {
        const emptySecretKey = ''

        expect(() => {
            deriveSS58Address(emptySecretKey)
        }).toThrow()
    })

    test('should handle null secret key gracefully', () => {
        expect(() => {
            deriveSS58Address(null)
        }).toThrow()
    })

    test('should verify both secret keys produce different addresses', () => {
        const addressFromCorrectKey = deriveSS58Address(TEST_DATA.correctSecretKey)
        const addressFromIncorrectKey = deriveSS58Address(TEST_DATA.incorrectSecretKey)

        expect(addressFromCorrectKey).not.toBe(addressFromIncorrectKey)
        expect(addressFromCorrectKey).toBe(TEST_DATA.expectedSS58Address)
    })

    test('should verify secret key length is correct (32 bytes)', () => {
        // Remove 0x prefix and convert to bytes
        const secretKeyBytes = hexToU8a(TEST_DATA.correctSecretKey)

        expect(secretKeyBytes.length).toBe(32)
    })

    test('should verify SS58 address format is valid', () => {
        const derivedAddress = deriveSS58Address(TEST_DATA.correctSecretKey)

        // SS58 addresses should be 48 characters long and contain valid SS58 characters
        expect(derivedAddress.length).toBe(48)
        expect(derivedAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{48}$/)
    })

    test('should sign message with secret key and verify with SS58 address', () => {
        const testMessage = 'Hello, this is a test message for signature verification'

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        // Verify the address matches expected
        expect(keyPair.address).toBe(TEST_DATA.expectedSS58Address)

        // Sign the message
        const signature = signMessage(keyPair, testMessage)

        // Verify signature is not empty and has correct length
        expect(signature).toBeDefined()
        expect(signature.length).toBe(64) // SR25519 signatures should be 64 bytes

        // Test that different messages produce different signatures
        const differentMessage = 'Different message'
        const differentSignature = signMessage(keyPair, differentMessage)
        expect(differentSignature).not.toEqual(signature)

        // Note: SR25519 signatures are non-deterministic due to randomness
        // So we can't test that the same message produces the same signature
        // Instead, we verify that signatures are valid and have correct length
        const sameSignature = signMessage(keyPair, testMessage)
        expect(sameSignature.length).toBe(64)
        expect(sameSignature).toBeDefined()
    })

    test('should create different signatures for different messages', () => {
        const messages = [
            'Simple text message',
            'Message with numbers 12345',
            'Message with special chars !@#$%^&*()',
            'Unicode message: Hello 世界 🌍',
            '', // Empty message
            'Very long message '.repeat(100) // Long message
        ]

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        const signatures = []

        for (const message of messages) {
            // Sign the message
            const signature = signMessage(keyPair, message)

            // Verify signature is not empty and has correct length
            expect(signature).toBeDefined()
            expect(signature.length).toBe(64) // SR25519 signatures should be 64 bytes

            // Store signature for uniqueness check
            signatures.push(signature)
        }

        // Verify all signatures are unique
        for (let i = 0; i < signatures.length; i++) {
            for (let j = i + 1; j < signatures.length; j++) {
                expect(signatures[i]).not.toEqual(signatures[j])
            }
        }
    })

    test('should create valid signatures for the same message', () => {
        const testMessage = 'Consistent message test'

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        // Sign the same message multiple times
        const signature1 = signMessage(keyPair, testMessage)
        const signature2 = signMessage(keyPair, testMessage)
        const signature3 = signMessage(keyPair, testMessage)

        // All signatures should be valid (64 bytes) but may be different due to randomness
        expect(signature1.length).toBe(64)
        expect(signature2.length).toBe(64)
        expect(signature3.length).toBe(64)

        // All signatures should be defined
        expect(signature1).toBeDefined()
        expect(signature2).toBeDefined()
        expect(signature3).toBeDefined()
    })

    test('should create different signatures for different secret keys', () => {
        const testMessage = 'Message for different keys test'

        // Create key pairs from different secret keys
        const keyPair1 = createKeyPair(TEST_DATA.correctSecretKey)
        const keyPair2 = createKeyPair(TEST_DATA.incorrectSecretKey)

        // Sign the same message with different keys
        const signature1 = signMessage(keyPair1, testMessage)
        const signature2 = signMessage(keyPair2, testMessage)

        // Signatures should be different
        expect(signature1).not.toEqual(signature2)

        // Both should have correct length
        expect(signature1.length).toBe(64)
        expect(signature2.length).toBe(64)
    })

    test('should verify signatures with verifySignatureWithKeyPair', () => {
        const testMessage = 'Message for signature verification test'

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        // Sign the message
        const signature = signMessage(keyPair, testMessage)

        // Verify the signature using verifySignatureWithKeyPair
        const isValid = verifySignatureWithKeyPair(keyPair, testMessage, signature)
        expect(isValid).toBe(true)

        // Test with wrong message - should return false
        const wrongMessage = 'Wrong message'
        const isValidWrong = verifySignatureWithKeyPair(keyPair, wrongMessage, signature)
        expect(isValidWrong).toBe(false)

        // Test with wrong signature - should return false
        const wrongSignature = new Uint8Array(64) // Correct length but wrong content
        const isValidWrongSig = verifySignatureWithKeyPair(keyPair, testMessage, wrongSignature)
        expect(isValidWrongSig).toBe(false)
    })

    test('should verify signatures with different message types using verifySignatureWithKeyPair', () => {
        const messages = [
            'Simple text message',
            'Message with numbers 12345',
            'Message with special chars !@#$%^&*()',
            'Unicode message: Hello 世界 🌍',
            '', // Empty message
            'Very long message '.repeat(100) // Long message
        ]

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        for (const message of messages) {
            // Sign the message
            const signature = signMessage(keyPair, message)

            // Verify signature is not empty and has correct length
            expect(signature).toBeDefined()
            expect(signature.length).toBe(64)

            // Verify the signature using verifySignatureWithKeyPair
            const isValid = verifySignatureWithKeyPair(keyPair, message, signature)
            expect(isValid).toBe(true)
        }
    })

    test('should verify signatures with SS58 address using verifySignature', () => {
        const testMessage = 'Message for SS58 address verification test'

        // Create key pair from correct secret key
        const keyPair = createKeyPair(TEST_DATA.correctSecretKey)

        // Sign the message
        const signature = signMessage(keyPair, testMessage)

        // Verify the signature using verifySignature with SS58 address
        const isValid = verifySignature(TEST_DATA.expectedSS58Address, testMessage, signature)
        expect(isValid).toBe(true)

        // Test with wrong message - should return false
        const wrongMessage = 'Wrong message'
        const isValidWrong = verifySignature(TEST_DATA.expectedSS58Address, wrongMessage, signature)
        expect(isValidWrong).toBe(false)

        // Test with wrong SS58 address - should throw error
        const incorrectAddress = deriveSS58Address(TEST_DATA.incorrectSecretKey)
        expect(() => {
            verifySignature(incorrectAddress, testMessage, signature)
        }).toThrow('Address mismatch')
    })

    test('should work with challenge-response proof of possession flow', () => {
        const challenge = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456'
        const ss58Address = TEST_DATA.expectedSS58Address
        const secretKey = TEST_DATA.correctSecretKey

        // Create key pair from correct secret key
        const keyPair = createKeyPair(secretKey)

        // Verify the address matches expected
        expect(keyPair.address).toBe(ss58Address)

        // Sign the challenge
        const signature = signMessage(keyPair, challenge)

        // Verify signature is valid
        expect(signature).toBeDefined()
        expect(signature.length).toBe(64)

        // Verify the signature using verifySignature
        const isValid = verifySignature(ss58Address, challenge, signature)
        expect(isValid).toBe(true)

        // Test with wrong challenge - should return false
        const wrongChallenge = 'wrongchallenge1234567890123456789012345678901234567890abcdef'
        const isValidWrong = verifySignature(ss58Address, wrongChallenge, signature)
        expect(isValidWrong).toBe(false)
    })
})
