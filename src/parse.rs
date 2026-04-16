use crate::unify::{Atom, AtomType, Term, Tree};

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

pub fn parse(input: &str) -> Result<Vec<Tree>, ParseError> {
    let mut roots: Vec<Tree> = Vec::new();
    let mut stack: Vec<(usize, Tree)> = Vec::new();

    for (idx, raw) in input.lines().enumerate() {
        let lineno = idx + 1;
        let indent = raw.chars().take_while(|c| *c == ' ').count();
        let after_indent = &raw[indent..];

        if after_indent.is_empty() || after_indent.chars().all(|c| c.is_whitespace()) {
            continue;
        }
        if after_indent.starts_with('\t') {
            return Err(ParseError {
                line: lineno,
                message: "tabs are not supported for indentation".into(),
            });
        }

        let mut chars = after_indent.chars();
        let prefix = chars.next().unwrap();
        let atom_type = match prefix {
            '-' => AtomType::Match,
            '+' => AtomType::Assert,
            '?' => AtomType::Ask,
            '!' => AtomType::Constrain,
            other => {
                return Err(ParseError {
                    line: lineno,
                    message: format!("invalid atom-type prefix '{other}'"),
                });
            }
        };

        let rest = chars.as_str().trim();
        let terms: Vec<Term> = rest
            .split_whitespace()
            .map(|tok| {
                if tok.chars().next().is_some_and(|c| c.is_uppercase()) {
                    Term::Variable(tok.to_string())
                } else {
                    Term::Symbol(tok.to_string())
                }
            })
            .collect();

        let node = Tree {
            atom: Atom { atom_type, terms },
            children: Vec::new(),
        };

        while let Some((top_indent, _)) = stack.last() {
            if *top_indent >= indent {
                let (_, completed) = stack.pop().unwrap();
                match stack.last_mut() {
                    Some((_, parent)) => parent.children.push(completed),
                    None => roots.push(completed),
                }
            } else {
                break;
            }
        }
        stack.push((indent, node));
    }

    while let Some((_, node)) = stack.pop() {
        match stack.last_mut() {
            Some((_, parent)) => parent.children.push(node),
            None => roots.push(node),
        }
    }

    Ok(roots)
}

pub fn format_term(t: &Term) -> String {
    match t {
        Term::Symbol(s) | Term::Variable(s) => s.clone(),
    }
}

pub fn format_tree(t: &Tree) -> String {
    let mut out = String::new();
    write_tree(t, 0, &mut out);
    out
}

fn write_tree(t: &Tree, indent: usize, out: &mut String) {
    let prefix = match t.atom.atom_type {
        AtomType::Match => '-',
        AtomType::Assert => '+',
        AtomType::Ask => '?',
        AtomType::Constrain => '!',
    };
    for _ in 0..indent {
        out.push_str("  ");
    }
    out.push(prefix);
    for term in &t.atom.terms {
        out.push(' ');
        out.push_str(&format_term(term));
    }
    out.push('\n');
    for c in &t.children {
        write_tree(c, indent + 1, out);
    }
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

    #[test]
    fn single_leaf() {
        let out = parse("- foo").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].atom.atom_type, AtomType::Match);
        assert_eq!(out[0].atom.terms, vec![sym("foo")]);
        assert!(out[0].children.is_empty());
    }

    #[test]
    fn doc_example() {
        let out = parse("- foo\n  ! bar X").unwrap();
        assert_eq!(out.len(), 1);
        let root = &out[0];
        assert_eq!(root.atom.atom_type, AtomType::Match);
        assert_eq!(root.atom.terms, vec![sym("foo")]);
        assert_eq!(root.children.len(), 1);
        let child = &root.children[0];
        assert_eq!(child.atom.atom_type, AtomType::Constrain);
        assert_eq!(child.atom.terms, vec![sym("bar"), var("X")]);
    }

    #[test]
    fn all_prefixes() {
        let out = parse("- a\n+ b\n? c\n! d").unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].atom.atom_type, AtomType::Match);
        assert_eq!(out[1].atom.atom_type, AtomType::Assert);
        assert_eq!(out[2].atom.atom_type, AtomType::Ask);
        assert_eq!(out[3].atom.atom_type, AtomType::Constrain);
    }

    #[test]
    fn siblings_and_nested_children() {
        let input = "- a\n  - x\n    - p\n    - q\n  - y\n- b";
        let out = parse(input).unwrap();
        assert_eq!(out.len(), 2);
        let a = &out[0];
        assert_eq!(a.atom.terms, vec![sym("a")]);
        assert_eq!(a.children.len(), 2);
        let x = &a.children[0];
        assert_eq!(x.atom.terms, vec![sym("x")]);
        assert_eq!(x.children.len(), 2);
        assert_eq!(x.children[0].atom.terms, vec![sym("p")]);
        assert_eq!(x.children[1].atom.terms, vec![sym("q")]);
        assert_eq!(a.children[1].atom.terms, vec![sym("y")]);
        assert_eq!(out[1].atom.terms, vec![sym("b")]);
    }

    #[test]
    fn blank_lines_skipped() {
        let out = parse("\n- a\n\n- b\n").unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn variable_vs_symbol() {
        let out = parse("- foo X bar Y").unwrap();
        assert_eq!(
            out[0].atom.terms,
            vec![sym("foo"), var("X"), sym("bar"), var("Y")]
        );
    }

    #[test]
    fn invalid_prefix() {
        let err = parse("@ bad").unwrap_err();
        assert_eq!(err.line, 1);
    }

    #[test]
    fn parses_example_file() {
        let input = include_str!("../example.sl");
        let out = parse(input).unwrap();
        assert!(!out.is_empty());
        // First tree is rooted at `- turn` with 3 children
        let first = &out[0];
        assert_eq!(first.atom.atom_type, AtomType::Match);
        assert_eq!(first.atom.terms, vec![sym("turn")]);
        assert_eq!(first.children.len(), 3);
        // First child `- activate` has 3 match children
        let activate = &first.children[0];
        assert_eq!(activate.atom.terms, vec![sym("activate")]);
        assert_eq!(activate.children.len(), 3);
        assert_eq!(
            activate.children[0].atom.terms,
            vec![sym("it"), sym("entwine")]
        );
        assert_eq!(
            activate.children[1].atom.terms,
            vec![sym("actor"), var("A")]
        );
        // Remaining two children of `- turn` are assertions
        assert_eq!(first.children[1].atom.atom_type, AtomType::Assert);
        assert_eq!(first.children[2].atom.atom_type, AtomType::Assert);
    }
}
