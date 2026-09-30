"""The PsychoPy builder's own loader and run builder, vendored verbatim.

The planner compiles a run design to a PsychoPy config; the thing that decides
whether that config is any good is the builder's own code, not ours.  So it
lives here, copied unchanged, and the demo player (``planner/demo.py``) builds
every run through it.  A config this refuses is a config the presentation
computer would refuse, said in the same words, one button away from the design
that produced it.

Upstream
--------
``https://github.com/2634367/fMRIInnerSpeechPsychoPy``, ``V1/``, commit
``c4deb464e6df8934a8b4dba7eab34f663da9da62``, copied 2026-09-30.

* ``builder/config.py`` <- ``V1/innerspeech/config.py`` - ``load`` (merge over the
  defaults, required keys, resolve, ``_validate``), ``ignored``, ``timed_phases``,
  ``rebalance``
* ``builder/bank.py``   <- ``V1/innerspeech/bank.py`` - ``load`` (the question bank),
  ``bounds``, ``sample_duration``, ``lead_durations``, ``build_run``
* ``planner/config/defaults.yaml`` <- ``V1/config/defaults.yaml`` - every setting the
  task reads, with its default.  **Its path is not a choice**: ``config.py`` resolves
  ``Path(__file__).parent.parent / "config" / "defaults.yaml"``, so that is where the
  vendored module looks, and putting it there is what lets ``config.py`` stay untouched.
  Every config is merged over it, so an export only needs the keys the design decides.
  The planner reads it too (``server.py``, ``_task_defaults``), so the Conditions panel
  can show the value of everything a design leaves to the task.

**Verbatim: do not edit these two files.**  They need only ``yaml``, ``json``,
``math`` and ``pathlib`` - no PsychoPy, no numpy - so they drop in whole.  When
the lab changes them, copy the new ones over the old and re-run the acceptance
check; anything the planner needs on top goes in ``planner/demo.py`` instead.

    base=https://raw.githubusercontent.com/2634367/fMRIInnerSpeechPsychoPy/<sha>/V1
    curl -sSf "$base/innerspeech/config.py" -o planner/builder/config.py
    curl -sSf "$base/innerspeech/bank.py"   -o planner/builder/bank.py
    curl -sSf "$base/config/defaults.yaml"  -o planner/config/defaults.yaml

The browser player is the lab's too, in ``static/player/``: ``stage.js``, ``feed.js``,
``debug.js`` and ``style.css`` <- ``V1/web/``, verbatim, and ``planner/demo.py`` mirrors
``V1/innerspeech/web.py``'s ``plan()`` and ``/files/`` rules.

Then update the commit above, and check every run of a design still plays:
``/designs/<name>/demo/<run>``.

There are no divergences: the planner adds nothing to these files and patches
nothing in them.  What the planner needs on top lives in ``planner/demo.py``.
"""

UPSTREAM = "https://github.com/2634367/fMRIInnerSpeechPsychoPy"
COMMIT = "c4deb464e6df8934a8b4dba7eab34f663da9da62"
COPIED = "2026-09-30"
