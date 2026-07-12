// POST /api/claim
// Verifies the on-chain fee payment, re-derives the correct allocation
// server-side (never trusts the client amount), and sends FBASE instantly
// from the distributor wallet.

import { ethers } from 'ethers';

const CONTRACT_ADDRESS = '0x0EdD929cE2C0cd057275dDDe3988Fc287e27134';
const FEE_RECEIVER = '0x580Aab97021D7D379c8d26444eAae332C3014ba7'.toLowerCase();
const FEE_ETH = '0.00003';
const MIN_SCORE = 0.25;
const BASE_RPC = 'https://mainnet.base.org';

const TIERS = [
  { min: 0.25, max: 0.5, amount: 5670 },
  { min: 0.5, max: 0.75, amount: 9562 },
  { min: 0.75, max: 999, amount: 13568 }
];

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

function tierFor(score) {
  for (const t of TIERS) {
    if (score >= t.min && score < t.max) return t;
  }
  if (score >= 0.75) return TIERS[2];
  return null;
}

// Simple duplicate-claim guard using Upstash Redis (optional — if not
// configured, this just skips the check rather than failing).
async function alreadyClaimed(fid) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;

  const r = await fetch(`${url}/get/claimed:${fid}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  return !!data.result;
}

async function markClaimed(fid, txHash) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;

  await fetch(`${url}/set/claimed:${fid}/${txHash}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { address, fid, feeTxHash } = req.body;

  if (!address || !fid || !feeTxHash) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // 1. Prevent double claims
    if (await alreadyClaimed(fid)) {
      return res.status(400).json({ success: false, error: 'Already claimed' });
    }

    // 2. Re-fetch the score server-side — never trust the client's tier
    const scoreRes = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
      {
        headers: {
          accept: 'application/json',
          'x-api-key': process.env.NEYNAR_API_KEY
        }
      }
    );
    const scoreData = await scoreRes.json();
    const user = scoreData.users && scoreData.users[0];
    const score = user?.experimental?.neynar_user_score ?? user?.score ?? 0;

    if (score < MIN_SCORE) {
      return res.status(403).json({ success: false, error: 'Not eligible' });
    }

    const tier = tierFor(score);
    if (!tier) {
      return res.status(403).json({ success: false, error: 'Not eligible' });
    }

    // 3. Verify the fee transaction actually happened on-chain
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const feeTx = await provider.getTransaction(feeTxHash);

    if (!feeTx) {
      return res.status(400).json({ success: false, error: 'Fee transaction not found' });
    }
    if (feeTx.from.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Fee transaction sender mismatch' });
    }
    if (feeTx.to.toLowerCase() !== FEE_RECEIVER) {
      return res.status(400).json({ success: false, error: 'Fee transaction recipient mismatch' });
    }
    if (feeTx.value < ethers.parseEther(FEE_ETH)) {
      return res.status(400).json({ success: false, error: 'Fee amount too low' });
    }

    const receipt = await provider.getTransactionReceipt(feeTxHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ success: false, error: 'Fee transaction not confirmed' });
    }

    // 4. Send FBASE from the distributor wallet
    const distributorWallet = new ethers.Wallet(process.env.DISTRIBUTOR_PRIVATE_KEY, provider);
    const token = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, distributorWallet);
    const decimals = await token.decimals();
    const amountWei = ethers.parseUnits(tier.amount.toString(), decimals);

    const sendTx = await token.transfer(address, amountWei);
    await sendTx.wait();

    // 5. Mark claimed (best-effort)
    await markClaimed(fid, sendTx.hash);

    return res.status(200).json({
      success: true,
      txHash: sendTx.hash,
      amount: tier.amount
    });

  } catch (err) {
    console.error('claim.js error:', err);
    return res.status(500).json({ success: false, error: 'Claim processing failed' });
  }
    }
