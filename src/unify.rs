use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Term {
    Symbol(String),
    Variable(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AtomType {
    Match,
    Assert,
    Ask,
    Constrain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Atom {
    pub atom_type: AtomType,
    pub terms: Vec<Term>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tree {
    pub atom: Atom,
    pub children: Vec<Tree>,
}

pub type Substitution = HashMap<String, Term>;

#[derive(Debug)]
pub struct Match<'r> {
    pub substitution: Substitution,
    pub root_image: &'r Tree,
}

pub fn resolve(term: &Term, subst: &Substitution) -> Term {
    let mut current = term.clone();
    loop {
        match &current {
            Term::Variable(name) => match subst.get(name) {
                Some(next) if next != &current => current = next.clone(),
                _ => return current,
            },
            Term::Symbol(_) => return current,
        }
    }
}

fn unify_term_pair(a: &Term, b: &Term, subst: Substitution) -> Option<Substitution> {
    let ra = resolve(a, &subst);
    let rb = resolve(b, &subst);
    match (ra, rb) {
        (Term::Symbol(x), Term::Symbol(y)) => (x == y).then_some(subst),
        (Term::Variable(v), other) | (other, Term::Variable(v)) => {
            if let Term::Variable(w) = &other {
                if *w == v {
                    return Some(subst);
                }
            }
            let mut s = subst;
            s.insert(v, other);
            Some(s)
        }
    }
}

fn unify_atom(pa: &Atom, ra: &Atom, subst: Substitution) -> Option<Substitution> {
    if pa.atom_type != ra.atom_type || pa.terms.len() != ra.terms.len() {
        return None;
    }
    let mut s = subst;
    for (pt, rt) in pa.terms.iter().zip(ra.terms.iter()) {
        s = unify_term_pair(pt, rt, s)?;
    }
    Some(s)
}

fn collect_with_paths<'a>(
    tree: &'a Tree,
    path: Vec<usize>,
    out: &mut Vec<(Vec<usize>, &'a Tree)>,
) {
    out.push((path.clone(), tree));
    for (i, c) in tree.children.iter().enumerate() {
        let mut child_path = path.clone();
        child_path.push(i);
        collect_with_paths(c, child_path, out);
    }
}

/// Two ref node paths are comparable iff one is a prefix of the other —
/// i.e., they lie on a single root-to-leaf line in the reference tree.
fn comparable(a: &[usize], b: &[usize]) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    long.starts_with(short)
}

fn match_children<'r>(
    pattern_children: &[Tree],
    chain_deepest: &[usize],
    all_ref_nodes: &[(Vec<usize>, &'r Tree)],
    subst: Substitution,
) -> Vec<Substitution> {
    let Some((first, rest)) = pattern_children.split_first() else {
        return vec![subst];
    };

    let mut results = Vec::new();
    for (cand_path, cand_node) in all_ref_nodes {
        if !comparable(cand_path, chain_deepest) {
            continue;
        }
        let new_deepest: &[usize] = if cand_path.len() > chain_deepest.len() {
            cand_path
        } else {
            chain_deepest
        };
        for m in try_match(first, cand_node, new_deepest, all_ref_nodes, subst.clone()) {
            results.extend(match_children(
                rest,
                chain_deepest,
                all_ref_nodes,
                m.substitution,
            ));
        }
    }
    results
}

fn try_match<'r>(
    pattern: &Tree,
    ref_node: &'r Tree,
    chain_deepest: &[usize],
    all_ref_nodes: &[(Vec<usize>, &'r Tree)],
    subst: Substitution,
) -> Vec<Match<'r>> {
    let Some(subst) = unify_atom(&pattern.atom, &ref_node.atom, subst) else {
        return Vec::new();
    };
    match_children(&pattern.children, chain_deepest, all_ref_nodes, subst)
        .into_iter()
        .map(|substitution| Match {
            substitution,
            root_image: ref_node,
        })
        .collect()
}

pub fn unify_term<'r>(pattern: &Tree, reference: &'r Tree) -> Vec<Match<'r>> {
    let mut all_nodes = Vec::new();
    collect_with_paths(reference, Vec::new(), &mut all_nodes);
    let mut results = Vec::new();
    for (path, node) in &all_nodes {
        results.extend(try_match(
            pattern,
            node,
            path,
            &all_nodes,
            Substitution::new(),
        ));
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(s: &str) -> Term {
        Term::Symbol(s.to_string())
    }
    fn var(s: &str) -> Term {
        Term::Variable(s.to_string())
    }
    fn atom(terms: Vec<Term>) -> Atom {
        Atom {
            atom_type: AtomType::Match,
            terms,
        }
    }
    fn tree(a: Atom, children: Vec<Tree>) -> Tree {
        Tree { atom: a, children }
    }
    fn leaf(a: Atom) -> Tree {
        tree(a, vec![])
    }

    #[test]
    fn ground_exact_match() {
        let pat = leaf(atom(vec![sym("foo")]));
        let refr = leaf(atom(vec![sym("foo")]));
        let ms = unify_term(&pat, &refr);
        assert_eq!(ms.len(), 1);
        assert!(ms[0].substitution.is_empty());
    }

    #[test]
    fn variable_binds_to_symbol() {
        let pat = leaf(atom(vec![sym("P"), var("X")]));
        let refr = leaf(atom(vec![sym("P"), sym("a")]));
        let ms = unify_term(&pat, &refr);
        assert_eq!(ms.len(), 1);
        assert_eq!(resolve(&var("X"), &ms[0].substitution), sym("a"));
    }

    #[test]
    fn same_variable_twice_constrains() {
        let pat = tree(
            atom(vec![sym("R"), var("X")]),
            vec![
                leaf(atom(vec![sym("L"), var("X")])),
                leaf(atom(vec![sym("M"), var("X")])),
            ],
        );
        let good = tree(
            atom(vec![sym("R"), sym("a")]),
            vec![
                leaf(atom(vec![sym("L"), sym("a")])),
                leaf(atom(vec![sym("M"), sym("a")])),
            ],
        );
        let good_ms = unify_term(&pat, &good);
        assert!(!good_ms.is_empty());
        assert_eq!(resolve(&var("X"), &good_ms[0].substitution), sym("a"));

        let bad = tree(
            atom(vec![sym("R"), sym("a")]),
            vec![
                leaf(atom(vec![sym("L"), sym("a")])),
                leaf(atom(vec![sym("M"), sym("b")])),
            ],
        );
        assert!(unify_term(&pat, &bad).is_empty());
    }

    #[test]
    fn nonadjacent_descendant_match() {
        let pat = tree(atom(vec![sym("A")]), vec![leaf(atom(vec![sym("C")]))]);
        let refr = tree(
            atom(vec![sym("A")]),
            vec![tree(
                atom(vec![sym("B")]),
                vec![leaf(atom(vec![sym("C")]))],
            )],
        );
        assert!(!unify_term(&pat, &refr).is_empty());
    }

    #[test]
    fn multiple_matches() {
        let pat = leaf(atom(vec![sym("L"), var("X")]));
        let refr = tree(
            atom(vec![sym("R")]),
            vec![
                leaf(atom(vec![sym("L"), sym("a")])),
                leaf(atom(vec![sym("L"), sym("b")])),
            ],
        );
        let ms = unify_term(&pat, &refr);
        assert_eq!(ms.len(), 2);
        let bindings: Vec<Term> = ms
            .iter()
            .map(|m| resolve(&var("X"), &m.substitution))
            .collect();
        assert!(bindings.contains(&sym("a")));
        assert!(bindings.contains(&sym("b")));
    }

    #[test]
    fn atom_type_mismatch_fails() {
        let pat = leaf(Atom {
            atom_type: AtomType::Match,
            terms: vec![sym("x")],
        });
        let refr = leaf(Atom {
            atom_type: AtomType::Assert,
            terms: vec![sym("x")],
        });
        assert!(unify_term(&pat, &refr).is_empty());
    }

    #[test]
    fn child_image_may_be_ancestor() {
        // pattern:  foo(bar)
        // reference: bar(foo)  -- child-image is an ancestor of parent-image
        let pat = tree(atom(vec![sym("foo")]), vec![leaf(atom(vec![sym("bar")]))]);
        let refr = tree(atom(vec![sym("bar")]), vec![leaf(atom(vec![sym("foo")]))]);
        let ms = unify_term(&pat, &refr);
        assert_eq!(ms.len(), 1);
        // root_image is the ref "foo" (inner), and pattern child bar maps
        // to the ref "bar" (outer/ancestor).
        assert_eq!(ms[0].root_image.atom.terms, vec![sym("foo")]);
    }

    #[test]
    fn siblings_may_live_on_different_ref_paths() {
        // pattern: root with two leaf children, C1 and C2.
        // reference: root with C1 in one subtree and C2 in a disjoint subtree.
        let pat = tree(
            atom(vec![sym("R")]),
            vec![leaf(atom(vec![sym("C1")])), leaf(atom(vec![sym("C2")]))],
        );
        let refr = tree(
            atom(vec![sym("R")]),
            vec![leaf(atom(vec![sym("C1")])), leaf(atom(vec![sym("C2")]))],
        );
        assert!(!unify_term(&pat, &refr).is_empty());
    }

    #[test]
    fn no_match_returns_empty() {
        let pat = leaf(atom(vec![sym("foo")]));
        let refr = leaf(atom(vec![sym("bar")]));
        assert!(unify_term(&pat, &refr).is_empty());
    }
}
