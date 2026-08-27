# Email draft — Cynet Health Canada burden / margin clarifications

**Reply on:** "Re: Requirements for RunRate Health Canada & Locums" (Sunil Dahiya, Aug 14 2026)
**To:** Sunil Dahiya
**Cc:** Pushpendra, Sharad, Ritu

**Subject:** Re: Requirements for RunRate Health Canada & Locums — 4 confirmations before we go live

---

Hi Sunil,

We have mapped the Canada placements from Nexus into the new Health Canada deal sheet and validated
506 rows against the run-rate sheet on SKU. **Your loading percentages are confirmed correct** — the
run-rate sheet's own numbers reproduce them. What is left is source data. Four questions:

**1. Which Nexus field holds the NL $70 weekly per diem?**
Run-rate has $70 on 92 of 93 NL rows; Nexus `lodging_amount` and `meal_amount` both read 0, so we
overstate margin by 6.22/hr on every NL row. Proof it is there — *SKU CH1423*: (76.26 − 70/11.25) /
57.70 = 1.2138, exactly your NL loading. (One BC row similarly has $400.)

**2. Pay rate differs on 77 of 506 rows — Nexus or run-rate?**
Both directions, spread −11.00 to +42.60, no consistent percentage, so not a loading issue.
*SKU CH1455*: 62.00 run-rate vs 52.00 Nexus. We assume Nexus; if these are later revisions, how do
they reach us? Nexus's `RATE_CHANGE` reads "NO".

**3. NL — the breakup or the flat 20.72%?**
Your table says 20.72% (1.2072), your note says "4% Vacation pay + 16.72%" (1.213888). We use
**1.213888** since the run-rate sheet reproduces it. 111 rows — say the word and we switch.

**4. T4A — is "Final Corp Cost" the right row?**
We follow your email (BC 0.00%, NS 1.95%). Run-rate differs both ways and is not internally
consistent — BC T4A alone shows 1.0000, 1.044, 1.0413 and 1.03 across its rows. Looks like older
percentages, but we want it confirmed before your table becomes the system of record.

Also `GUARANTEED HOURS` differs on many rows — **no margin impact** (bonus is 0 on 291 of 297) but
the column reports differently. Nexus has 45 where run-rate has 38 on *SKU CH1255*. Which one?

Only 1 and 2 move margins. Happy to do a call if quicker.

Thanks,
Santosh
