#!/usr/bin/env python3
"""Write the built-in demo question bank.

The planner plans designs, not stimuli - so the bank it ships with is
deliberately content-free: eighty placeholder propositions whose truth anyone
can check at a glance, over the two views the player can draw without a file
(``text`` and ``shapes``).  It exists so a run can be *played*, and so every
timing path - both labels, every condition, the question and cue screens - is
exercised without borrowing the lab's stimuli.

Forty ``yes`` and forty ``no``: ``bank.build_run`` splits each condition's
trials by ``run.label_balance_pct`` - evenly by default - and wants enough of
both in stock.  ``yes`` and ``no`` are the task's own ``responses.labels``; a
design that changes them needs a bank written for the new pair.  No ``image`` items, so nothing looks for a
picture that is not there.  The real bank goes in ``demo-banks/`` instead, and
is picked on the demo page (see the README).

Run from the repository root; it overwrites ``demo-bank/questions/bank.json``::

    python3 demo-bank/make-bank.py
"""
import json
import pathlib
import uuid

# A fixed namespace, so re-running this writes the same uuids and a design
# demoed at a given seed keeps playing the same run.
NS = uuid.UUID("5f6f1f8e-0b1a-5c3a-9f2b-8d7c6e5a4b30")

OUT = pathlib.Path(__file__).resolve().parent / "questions" / "bank.json"

# innerspeech/views/shapes_view.py, as stage.js draws them.
PAIRS = [("triangle", "square"), ("circle", "diamond"), ("pentagon", "hexagon"),
         ("square", "circle"), ("triangle", "hexagon"), ("diamond", "pentagon")]
#: relation -> (the other one, where the pair sits when the answer is yes)
RELATIONS = [("above", "vertical"), ("below", "vertical"),
             ("left of", "horizontal"), ("right of", "horizontal")]
#: the two slots of a pair, first one listed first
SLOTS = {"vertical": ([0.0, 0.06], [0.0, -0.16]),
         "horizontal": ([-0.16, -0.05], [0.16, -0.05])}


def question(category, view, text, answer, family, params=None):
    return {"uuid": str(uuid.uuid5(NS, f"{view}|{text}")), "category": category,
            "view": view, "text": text, "answer": answer, "family": family,
            "params": params or {}}


def shapes():
    """24 relative-position items, 12 yes and 12 no."""
    out = []
    for i, (first, second) in enumerate(PAIRS):
        for j, (relation, axis) in enumerate(RELATIONS):
            yes = (i + j) % 2 == 0
            near, far = SLOTS[axis]
            # `first` takes the slot the relation names when the answer is yes
            holds = relation in ("above", "left of")
            a, b = (near, far) if holds == yes else (far, near)
            out.append(question(
                "perceptual_relational", "shapes",
                f"Is the {first} {relation} the {second}?", "yes" if yes else "no",
                f"relpos_{first}_{second}",
                {"shapes": [{"kind": first, "pos": a}, {"kind": second, "pos": b}]}))
    return out


def arithmetic():
    """20 comparison items, 10 yes and 10 no."""
    out = []
    for n in range(10):
        a, b = 3 + n, 4 + (n * 3) % 7
        gap = 1 + n % 3
        yes = n % 2 == 0
        c = a + b - gap if yes else a + b + gap
        out.append(question("arithmetic", "text",
                            f"Is {a} + {b} greater than {c}?", "yes" if yes else "no",
                            "arith_sum_greater"))
    for n in range(10):
        a, b = 12 + (n * 5) % 9, 2 + n % 6
        gap = 1 + n % 3
        yes = n % 2 == 0
        c = a - b + gap if yes else a - b - gap
        out.append(question("arithmetic", "text",
                            f"Is {a} − {b} less than {c}?", "yes" if yes else "no",
                            "arith_difference_less"))
    return out


def linguistic():
    """18 alphabet-order items, 9 yes and 9 no."""
    pairs = [("M", "H"), ("R", "D"), ("K", "B"), ("T", "P"), ("F", "C"),
             ("W", "N"), ("J", "G"), ("S", "L"), ("Q", "E")]
    out = []
    for n, (late, early) in enumerate(pairs):
        yes = n % 2 == 0
        first, second = (late, early) if yes else (early, late)
        out.append(question("linguistic", "text",
                            f"Does {first} come after {second} in the alphabet?",
                            "yes" if yes else "no", "alpha_after"))
    for n, (late, early) in enumerate(pairs):
        yes = n % 2 == 1
        first, second = (early, late) if yes else (late, early)
        out.append(question("linguistic", "text",
                            f"Does {first} come before {second} in the alphabet?",
                            "yes" if yes else "no", "alpha_before"))
    return out


def logic():
    """18 number-property items, 9 yes and 9 no."""
    out = []
    for n in range(6):
        value = 14 + n * 7                     # alternates even and odd
        out.append(question("logic", "text", f"Is {value} an even number?",
                            "yes" if value % 2 == 0 else "no", "parity"))
    for n in range(6):
        divisor = 3 + n % 3
        multiple = divisor * (4 + n)
        value = multiple if n % 2 == 0 else multiple + 1
        out.append(question("logic", "text", f"Is {value} divisible by {divisor}?",
                            "yes" if value % divisor == 0 else "no", "divisible"))
    for n in range(6):
        low, high = 10 + n * 4, 40 + n * 4
        value = (low + high) // 2 if n % 2 == 0 else high + 3
        out.append(question("logic", "text",
                            f"Is {value} greater than {low} and less than {high}?",
                            "yes" if low < value < high else "no", "between"))
    return out


def build():
    questions = shapes() + arithmetic() + linguistic() + logic()
    seen = set()
    for q in questions:
        if q["uuid"] in seen:
            raise SystemExit(f"duplicate question: {q['text']}")
        seen.add(q["uuid"])
    counts = {"yes": 0, "no": 0}
    for q in questions:
        counts[q["answer"]] += 1
    if counts["yes"] != counts["no"]:
        raise SystemExit(f"labels are not balanced: {counts}")
    return questions, counts


if __name__ == "__main__":
    questions, counts = build()
    OUT.write_text(json.dumps(questions, indent=1, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    print(f"{OUT}: {len(questions)} questions, "
          f"{counts['yes']} yes / {counts['no']} no")
