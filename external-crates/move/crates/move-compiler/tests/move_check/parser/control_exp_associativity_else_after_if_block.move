// tests that control structures are right associative when not immediately followed by a block

module 0x42::M {

    struct S has copy, drop { f: u64 }

    fun t(_cond: bool, _s1: S, _s2: S) {
        // (if (cond) s1 else s2).f
        let _: u64 = if (cond) { s1 } else { s2 }.f;

        // (if (cond) s1).f else (s2.f)
        // so parsing error
        if (cond) { s1 }.f else s2.f


    }
}
