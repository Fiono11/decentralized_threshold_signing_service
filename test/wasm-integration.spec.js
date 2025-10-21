// WASM Integration Tests for Olaf Threshold Public Key Generation

import { setup, expect } from 'test-ipfs-example/browser'

const test = setup()

// Test data from the example
const TEST_RECIPIENTS = [
    "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw",
    "5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy"
]

const TEST_SECRET_KEY_1 = "0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce"
const TEST_SECRET_KEY_2 = "0xdb9ddbb3d6671c4de8248a4fba95f3d873dc21a0434b52951bb33730c1ac93d7"

let url

test.describe('WASM Integration Tests for Olaf Threshold Public Key Generation:', () => {
    test.beforeAll(async ({ servers }, testInfo) => {
        testInfo.setTimeout(5 * 60_000)
        url = servers[0].url
    }, {})

    test.beforeEach(async ({ page }) => {
        // Navigate to the main page which initializes WASM
        await page.goto(url)

        // Wait for WASM module to be initialized
        await page.waitForFunction(() => window.wasmReady === true, { timeout: 30000 })
    })

    test('should correctly convert secret key to SS58 address', async ({ page }) => {
        const result = await page.evaluate(({ secretKey, expectedAddress }) => {
            const derivedAddress = window.secretKeyToSS58Address(secretKey)
            return {
                derivedAddress,
                expectedAddress,
                match: derivedAddress === expectedAddress
            }
        }, {
            secretKey: TEST_SECRET_KEY_1,
            expectedAddress: TEST_RECIPIENTS[0]
        })

        expect(result.match).toBe(true)
        expect(result.derivedAddress).toBe(result.expectedAddress)

        console.log(`Secret key: ${TEST_SECRET_KEY_1}`)
        console.log(`Expected address: ${result.expectedAddress}`)
        console.log(`Derived address: ${result.derivedAddress}`)
        console.log(`Match: ${result.match}`)
    })

    test('should successfully generate AllMessage for participant 1', async ({ page }) => {
        const result = await page.evaluate(({ secretKey, recipients, threshold }) => {
            const keypairBytes = window.createKeypairBytes(secretKey)

            // Convert recipients to concatenated public key bytes
            const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
            const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])

            // Concatenate recipient public keys
            const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
            recipientsConcat.set(recipient1Bytes, 0)
            recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

            // Call the WASM function
            const result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

            return {
                isUint8Array: result instanceof Uint8Array,
                length: result.length,
                first16Bytes: Array.from(result.slice(0, 16))
            }
        }, { secretKey: TEST_SECRET_KEY_1, recipients: TEST_RECIPIENTS, threshold: 2 })

        // Validate the result
        expect(result.isUint8Array).toBe(true)
        expect(result.length).toBeGreaterThan(0)

        console.log(`Generated AllMessage for participant 1: ${result.length} bytes`)
        console.log(`First 16 bytes: ${result.first16Bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
    })

    test('should successfully generate AllMessage for participant 2', async ({ page }) => {
        const result = await page.evaluate(({ secretKey, recipients, threshold }) => {
            const keypairBytes = window.createKeypairBytes(secretKey)

            const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
            const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])

            const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
            recipientsConcat.set(recipient1Bytes, 0)
            recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

            const result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

            return {
                isUint8Array: result instanceof Uint8Array,
                length: result.length,
                first16Bytes: Array.from(result.slice(0, 16))
            }
        }, { secretKey: TEST_SECRET_KEY_2, recipients: TEST_RECIPIENTS, threshold: 2 })

        expect(result.isUint8Array).toBe(true)
        expect(result.length).toBeGreaterThan(0)

        console.log(`Generated AllMessage for participant 2: ${result.length} bytes`)
        console.log(`First 16 bytes: ${result.first16Bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
    })
})
