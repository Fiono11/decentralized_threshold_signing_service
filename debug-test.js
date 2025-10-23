// Debug script to compare integration test vs manual test parameters
// This will help us identify the exact differences

const TEST_SECRET_KEY_1 = "0x473a77675b8e77d90c1b6dc2dbe6ac533b0853790ea8bcadf0ee8b5da4cfbbce"
const TEST_RECIPIENTS = [
    "5CXkZyy4S5b3w16wvKA2hUwzp5q2y7UtRPkXnW97QGvDN8Jw",
    "5Gma8SNsn6rkQf9reAWFQ9WKq8bwwHtSzwMYtLTdhYsGPKiy"
]

// Integration test logic (from test/index.spec.js)
function integrationTestLogic(secretKey, recipients, threshold) {
    console.log('=== INTEGRATION TEST LOGIC ===')

    const keypairBytes = window.createKeypairBytes(secretKey)
    console.log(`Keypair bytes length: ${keypairBytes.length}`)
    console.log(`Keypair first 16 bytes: ${Array.from(keypairBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Convert recipients to concatenated public key bytes
    const recipient1Bytes = window.ss58ToPublicKeyBytes(recipients[0])
    const recipient2Bytes = window.ss58ToPublicKeyBytes(recipients[1])

    console.log(`Recipient 1 (${recipients[0]}): ${recipient1Bytes.length} bytes`)
    console.log(`Recipient 1 first 16 bytes: ${Array.from(recipient1Bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    console.log(`Recipient 2 (${recipients[1]}): ${recipient2Bytes.length} bytes`)
    console.log(`Recipient 2 first 16 bytes: ${Array.from(recipient2Bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Concatenate recipient public keys
    const recipientsConcat = new Uint8Array(recipient1Bytes.length + recipient2Bytes.length)
    recipientsConcat.set(recipient1Bytes, 0)
    recipientsConcat.set(recipient2Bytes, recipient1Bytes.length)

    console.log(`Concatenated recipients: ${recipientsConcat.length} bytes`)
    console.log(`Concatenated first 32 bytes: ${Array.from(recipientsConcat.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Call the WASM function
    const result = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

    console.log(`AllMessage length: ${result.length} bytes`)
    console.log(`AllMessage first 32 bytes: ${Array.from(result.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('')}`)

    return result
}

// Manual test logic (from index.js)
function manualTestLogic(secretKey, recipients, threshold) {
    console.log('\n=== MANUAL TEST LOGIC ===')

    const keypairBytes = window.createKeypairBytes(secretKey)
    console.log(`Keypair bytes length: ${keypairBytes.length}`)
    console.log(`Keypair first 16 bytes: ${Array.from(keypairBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Convert recipients to concatenated public key bytes
    const recipientBytes = recipients.map(recipient => {
        return window.ss58ToPublicKeyBytes(recipient)
    })

    console.log(`Recipients count: ${recipientBytes.length}`)
    for (let i = 0; i < recipientBytes.length; i++) {
        console.log(`Recipient ${i + 1} (${recipients[i]}): ${recipientBytes[i].length} bytes`)
        console.log(`Recipient ${i + 1} first 16 bytes: ${Array.from(recipientBytes[i].slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
    }

    // Concatenate all recipient public keys
    const totalLength = recipientBytes.reduce((sum, bytes) => sum + bytes.length, 0)
    const recipientsConcat = new Uint8Array(totalLength)
    let offset = 0
    for (const bytes of recipientBytes) {
        recipientsConcat.set(bytes, offset)
        offset += bytes.length
    }

    console.log(`Concatenated recipients: ${recipientsConcat.length} bytes`)
    console.log(`Concatenated first 32 bytes: ${Array.from(recipientsConcat.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)

    // Call the WASM function to generate AllMessage
    const allMessage = window.wasm_simplpedpop_contribute_all(keypairBytes, threshold, recipientsConcat)

    console.log(`AllMessage length: ${allMessage.length} bytes`)
    console.log(`AllMessage first 32 bytes: ${Array.from(allMessage.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('')}`)

    return allMessage
}

// Run both tests
console.log('Running debug comparison...')
const integrationResult = integrationTestLogic(TEST_SECRET_KEY_1, TEST_RECIPIENTS, 2)
const manualResult = manualTestLogic(TEST_SECRET_KEY_1, TEST_RECIPIENTS, 2)

console.log('\n=== COMPARISON ===')
console.log(`Integration result length: ${integrationResult.length}`)
console.log(`Manual result length: ${manualResult.length}`)

const integrationHex = Array.from(integrationResult).map(b => b.toString(16).padStart(2, '0')).join('')
const manualHex = Array.from(manualResult).map(b => b.toString(16).padStart(2, '0')).join('')

console.log(`Results are identical: ${integrationHex === manualHex}`)
if (integrationHex !== manualHex) {
    console.log(`First difference at byte: ${Array.from(integrationResult).findIndex((byte, i) => byte !== manualResult[i])}`)
}
